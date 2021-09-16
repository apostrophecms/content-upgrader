const { findSourceMap } = require('module');
const { MongoClient } = require('mongodb');

module.exports = {
  defaultLocale: 'en',
  async afterConstruct(self) {
    self.addUpgradeTask();
  },
  construct(self, options) {
    self.a2ToA3Ids = {};
    self.options.mapDocs = {
      'apostrophe-user': async (doc) => {
        // For now we do not import users. Determining their proper permissions
        // equivalent in A3 is very subjective and they are easy to add
        return false;
      },
      'apostrophe-global': '@apostrophecms/global',
      'apostrophe-image': '@apostrophecms/image',
      'apostrophe-file': '@apostrophecms/file',
      'trash': '@apostrophecms/archive-page'
    };
    self.options.mapWidgets = {
      ...self.options.mapDocs
    };
    self.on('apostrophe:afterInit', 'connectToNewDb', async () => {
      const uri = self.apos.argv['a3-db'];
      if (!uri) {
        fail('You must specify the --a3-db option, which must be a MongoDB URI for the new database');
      }
      const url = new URL(uri);
      if (self.apos.options.shortName === url.pathname.substring(1)) {
        fail('For prevention of data loss, your a3 database name must not match the A2 project shortName.');
      }
      self.client = new MongoClient(uri, { useUnifiedTopology: true });
      await self.client.connect();
      self.docs = self.client.db().collection('aposDocs');
    });
    self.addUpgradeTask = () => {
      self.addTask('upgrade', 'Upgrade content for A3', self.upgradeTask);
    };
    self.upgradeTask = async (apos, argv) => {
      await self.upgradePass();
      await self.rewritePass();
    },
    self.upgradePass = async () => {
      await self.apos.migrations.eachDoc({}, self.upgradeDoc);
    },
    self.rewritePass = async () => {
      // Separate pass because docs cant't know each other's new aposDocIds
      // until the end of the first pass. We have to do our own iteration
      // because we're talking to the new database
      const cursor = self.docs.find({});
      while (true) {
        const doc = await cursor.next();
        if (!doc) {
          break;
        }
        await self.rewriteDocJoinIds(doc);
      }
    },
    self.upgradeDoc = async doc => {
      doc = await self.upgradeDocCore(doc);
      if (!doc) {
        return;
      }
      if (doc.slug.startsWith('/')) {
        doc = await self.upgradePage(doc);
        if (!doc) {
          return;
        }
      }
      if (self.options.transformDoc) {
        doc = await self.options.transformDoc(doc);
        if (!doc) {
          return;
        }
      }
      const mapping = self.options.mapDocs && self.options.mapDocs[doc.type];
      if (mapping) {
        if ((typeof mapping) === 'function') {
          doc = await mapping(doc);
          if (!doc) {
            return;
          }
        } else {
          // Just a type name change
          doc = {
            ...doc,
            type: mapping
          };
        }
      }
      // upgradeDocCore sets this flag when the A2 site does not have workflow
      // but the type will need draft/published support in A3
      const replicateToPublished = doc._replicateToPublished;
      delete doc._replicateToPublished;
      if (doc.slug.startsWith('/')) {
        console.log(`*** inserting: ${doc.slug} ${doc._id}`);
      }
      self.a2ToA3Ids[doc.a2Id] = doc.aposDocId;
      await self.docs.insertOne(doc);
      if (replicateToPublished) {
        await self.docs.insertOne({
          ...doc,
          _id: doc._id.replace(':draft', ':published'),
          aposLocale: doc.aposLocale.replace(':draft', ':published'),
          aposMode: 'published'
        });
      }
    };
    self.upgradeDocCore = async doc => {
      doc = {
        ...doc,
        metaType: 'doc'
      };
      doc.archived = doc.trash;
      doc = await self.upgradeDocIdentity(doc);
      if (!doc) {
        return false;
      }
      const manager = self.apos.docs.getManager(doc.type);
      if (!manager) {
        return false;
      }
      const schema = manager.schema;
      doc = await self.upgradeObject(schema, doc);
      // Spontaneous top level areas might not be accounted for yet
      // (in A3 they must be added to the schema in the code)
      for (const [ key, val ] of Object.entries(doc)) {
        if (val && (val.type === 'area')) {
          await self.upgradeFieldTypes.area(doc, {
            type: 'area',
            name: key
          });
        }
      }
      return doc;
    };
    self.upgradeDocIdentity = async doc => {
      const workflow = self.apos.modules['apostrophe-workflow'];
      doc.a2Id = doc._id;
      if (workflow) {
        if (doc.workflowGuid) {
          const locale = doc.workflowLocale.replace('-draft', '');
          const mode = doc.workflowLocale.endsWith('-draft') ? 'draft' : 'published';
          if (doc.archived && (mode === 'published')) {
            return false;
          }
          doc._id = `${doc.workflowGuid}:${locale}:${mode}`;
          doc.aposDocId = doc.workflowGuid;
          doc.aposLocale = `${locale}:${mode}`;
          doc.aposMode = mode;
        }
      } else {
        // A3 always has draft/published at a minimum, we have to figure out what types
        // would naturally be exempt without the workflow module to tell us
        const exempt = [ 'apostrophe-user', 'apostrophe-group', 'apostrophe-redirect' ];
        if (!exempt.includes(doc.type)) {
          doc._id = `${doc._id}:${self.options.defaultLocale}:draft`;
          if (doc.slug.startsWith('/')) {
            console.log(`Reset the _id of ${doc.slug} to ${doc._id}`);
          }
          doc.aposDocId = doc._id.split(':')[0];
          doc.aposLocale = `${self.options.defaultLocale}:draft`;
          doc.aposMode = 'draft';
          if (!doc.trash) {
            // We won't find a corresponding published doc in the db but we
            // need one, so drop a hint to insert one later
            doc._replicateToPublished = true;
          }
        }
      }
      return doc;
    };
    self.upgradePage = async doc => {
      const workflow = self.apos.modules['apostrophe-workflow'];
      if (!workflow) {
        return doc;
      }
      const prefix = workflow.prefixes[workflow.liveify(doc.workflowLocale)];
      if (doc.slug.startsWith(prefix)) {
        doc.slug = doc.slug.substring(prefix.length);
      }
      return doc;
    };
    self.upgradeObject = async (schema, object) => {
      for (const field of schema) {
        if (self.upgradeFieldTypes[field.type]) {
          object = await self.upgradeFieldTypes[field.type](object, field);
        }
      }
      return object;
    },
    self.upgradeWidget = async widget => {
      widget.metaType = 'widget';
      const manager = self.apos.areas.getWidgetManager(widget.type);
      if (!manager) {
        return false;
      }
      widget = await self.upgradeObject(manager.schema, widget);
      if (self.options.transformWidget) {
        widget = await self.options.transformWidget(widget);
        if (!widget) {
          return;
        }
      }
      return widget;
    },
    self.upgradeFieldTypes = {
      async joinByOne(doc, field) {
        doc[`${field.name.replace(/^_/, '')}Ids`] = doc[field.idField] ? [ doc[field.idField] ] : [];
        return doc;
      },
      async array(doc, field) {
        const newArray = [];
        for (const object of (doc[field.name] || [])) {
          newArray.push({
            ...await self.upgradeObject(field.schema, object),
            metaType: 'arrayItem'
          });
        }
        doc[field.name] = newArray;
        return doc;
      },
      async object(doc, field) {
        if (doc[field.name]) {
          doc[field.name] = [
            {
              ...await self.upgradeObject(field.schema, doc[field.name]),
              metaType: 'arrayItem'
            }
          ];
        }
        return doc;
      },
      async area(doc, field) {
        if (doc[field.name]) {
          const area = doc[field.name];
          area.metaType = 'area';
          const newItems = [];
          for (const widget of (area.items || [])) {
            const newWidget = await self.upgradeWidget(widget);
            if (newWidget) {
              newItems.push(newWidget);
            }
          }
          doc[field.name].items = newItems;
        }
        return doc;
      }
    };
    self.rewriteDocJoinIds = async doc => {
      const modified = rewrite(doc);
      if (modified) {
        return self.docs.replaceOne({
          _id: doc._id
        }, doc);
      }
      function rewrite(object) {
        let modified = false;
        const patchKeys = {};
        for (const key of Object.keys(object)) {          
          if (key === 'a2Id') {
            continue;
          }
          if (self.a2ToA3Ids[key] && (self.a2ToA3Ids[key] !== key)) {
            patchKeys[key] = self.a2ToA3Ids[key];
          }
          if (object[key]) {
            if ((object[key] != null) && ((typeof object[key]) === 'object')) {
              modified = modified || rewrite(object[key]);
            } else if (self.a2ToA3Ids[object[key]] && self.a2ToA3Ids[object[key]] !== object[key]) {
              object[key] = self.a2ToA3Ids[object[key]];
              modified = true;
            }
          }
        }
        // Outside the iterator above so we don't confuse it
        for (const [ key, val ] of Object.entries(patchKeys)) {
          object[val] = object[key];
          delete object[key];
          modified = true;
        }
        return modified;
      }
    };    
  }
};

function fail(message) {
  console.error(`\n\n🛑 ${message}\n`);
  process.exit(1);
}
