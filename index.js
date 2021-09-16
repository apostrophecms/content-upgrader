const { MongoClient } = require('mongodb');

module.exports = {
  defaultLocale: 'en',
  async afterConstruct(self) {
    self.addUpgradeTask();
  },
  construct(self, options) {
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
      return self.apos.migrations.eachDoc({}, self.upgradeDoc);
    },
    self.upgradeDoc = async doc => {
      let newDoc = await self.upgradeDocCore(doc);
      if (!newDoc) {
        return;
      }
      if (newDoc.slug.startsWith('/')) {
        newDoc = await self.upgradePage(newDoc);
        if (!newDoc) {
          return;
        }
      }
      if (self.options.transformDoc) {
        newDoc = await self.options.transformDoc(newDoc);
        if (!newDoc) {
          return;
        }
      }
      const mapping = self.options.mapDocs && self.options.mapDocs[doc.type];
      if (mapping) {
        if ((typeof mapping) === 'function') {
          newDoc = await mapping(newDoc);
          if (!newDoc) {
            return;
          }
        } else {
          // Just a type name change
          newDoc = {
            ...newDoc,
            type: mapping
          };
        }
      }
      // upgradeDocCore sets this flag when the A2 site does not have workflow
      // but the type will need draft/published support in A3
      const replicateToPublished = newDoc._replicateToPublished;
      delete newDoc._replicateToPublished;
      if (newDoc.slug.startsWith('/')) {
        console.log(`*** inserting: ${newDoc.slug} ${newDoc._id}`);
      }
      await self.docs.insertOne(newDoc);
      if (replicateToPublished) {
        await self.docs.insertOne({
          ...newDoc,
          _id: newDoc._id.replace(':draft', ':published'),
          aposLocale: newDoc.aposLocale.replace(':draft', ':published'),
          aposMode: 'published'
        });
      }
    };
    self.upgradeDocCore = async doc => {
      let newDoc = {
        ...doc,
        metaType: 'doc'
      };
      newDoc.archived = newDoc.trash;
      newDoc = await self.upgradeDocIdentity(newDoc);
      if (!newDoc) {
        return false;
      }
      const manager = self.apos.docs.getManager(newDoc.type);
      if (!manager) {
        return false;
      }
      const schema = manager.schema;
      newDoc = await self.upgradeObject(schema, newDoc);
      // Spontaneous top level areas might not be accounted for yet
      // (in A3 they must be added to the schema in the code)
      for (const [ key, val ] of Object.entries(newDoc)) {
        if (val && (val.type === 'area')) {
          await self.upgradeFieldTypes.area(newDoc, {
            type: 'area',
            name: key
          });
        }
      }
      return newDoc;
    };
    self.upgradeDocIdentity = async doc => {
      const workflow = self.apos.modules['apostrophe-workflow'];
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
          doc.aposDocId = doc._id;
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
  }
};

function fail(message) {
  console.error(`\n\n🛑 ${message}\n`);
  process.exit(1);
}
