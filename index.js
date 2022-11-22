const { findSourceMap } = require('module');
const { MongoClient } = require('mongodb');

module.exports = {
  mapLocales: {
    'default': 'en'
  },
  async afterConstruct(self) {
    self.addUpgradeTask();
  },
  construct(self, options) {
    self.a2ToA3Paths = new Map();
    self.a2ToA3Ids = new Map();
    self.docTypesFound = new Set();
    self.widgetTypesFound = new Set();
    self.options.mapDocTypes = {
      'apostrophe-user': async (doc) => {
        // For now we do not import users. Determining their proper permissions
        // equivalent in A3 is very subjective and they are easy to add back manually
        return false;
      },
      'apostrophe-group': async (doc) => {
        // For now A3 has no direct equivalent
        return false;
      },
      'apostrophe-global': '@apostrophecms/global',
      'apostrophe-image': '@apostrophecms/image',
      'apostrophe-file': '@apostrophecms/file',
      async trash (doc) {
        doc.type = '@apostrophecms/archive-page';
        doc.parkedId = 'archive';
        doc.slug = '/archive';
        return doc;
      },
      ...self.options.mapDocTypes
    };
    self.options.mapWidgetTypes = {
      'apostrophe-rich-text': '@apostrophecms/rich-text',
      'apostrophe-images': async (widget) => ({
        ...widget,
        type: '@apostrophecms/image',
        imageFields: widget.relationships,
        imageIds: (widget.pieceIds || []).slice(0, 1)
      }),
      'apostrophe-video': '@apostrophecms/video',
      'apostrophe-html': '@apostrophecms/html',
      ...self.options.mapWidgetTypes
    };
    self.connectToNewDb = async () => {
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
      self.attachments = self.client.db().collection('aposAttachments');
      const count = await self.docs.countDocuments({});
      if (count) {
        if (!self.apos.argv.drop) {
          fail('Your new A3 database already contains data.\nIf you are comfortable DELETING that data for a fresh upgrade attempt,\nrun again with: --drop');
        }
      }
    };
    self.addUpgradeTask = () => {
      self.addTask('upgrade', 'Upgrade content for A3', self.upgradeTask);
    };
    self.upgradeTask = async (apos, argv) => {
      await self.connectToNewDb();
      await self.upgradeDocsPass();
      await self.rewriteDocsJoinIdsPass();
      await self.upgradeAttachments();
      await self.report();
    };
    self.upgradeDocsPass = async () => {
      await self.docs.deleteMany({});
      const cursor = self.apos.docs.db.find({}).sort({
        level: 1
      });
      while (true) {
        const doc = await cursor.next();
        if (!doc) {
          break;
        }
        await self.upgradeDoc(doc);
      }
    };
    self.rewriteDocsJoinIdsPass = async () => {
      // Second pass because docs cant't know each other's new aposDocIds
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
    };
    self.upgradeAttachments = async () => {
      await self.attachments.deleteMany({});
      await self.apos.migrations.each(self.apos.attachments.db, {}, 5, async attachment => {
        attachment.archivedDocIds = attachment.trashDocIds;
        delete attachment.trashDocIds;
        await self.attachments.insertOne(attachment);
      });
    };
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
      const mapping = self.options.mapDocTypes && self.options.mapDocTypes[doc.type];
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
      self.a2ToA3Ids.set(doc.a2Id, doc.aposDocId);
      await self.docs.insertOne(doc);
      self.docTypesFound.add(doc.type);
      self.markWidgetTypesFound(doc);
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
      if (doc.type === 'site') {
        doc = await self.upgradeSiteLocales(doc);
      }
      const manager = self.apos.docs.getManager(doc.type);
      if (!manager) {
        return false;
      }
      if (manager.schema.find(field => field.name === 'published')) {
        // Not quite the same thing, but a useful approximation
        doc.visibility = doc.published ? 'public' : 'loginRequired'
      } else {
        doc.visibility = 'public';
      }
      const schema = manager.schema;
      doc = await self.upgradeObject(schema, doc, {
        scopedArrayBase: `doc.${doc.type}`
      });
      // Spontaneous top level areas might not be accounted for yet
      // (in A3 they must be added to the schema in the code)
      for (const [ key, val ] of Object.entries(doc)) {
        if (val && (val.type === 'area')) {
          // Make sure we didn't process it already due to inclusion in the schema
          if (!val.metaType) {
            await self.upgradeFieldTypes.area(doc, {
              type: 'area',
              name: key
            }, {});
          }
        }
      }
      return doc;
    };
    self.upgradeDocIdentity = async doc => {
      const workflow = self.apos.modules['apostrophe-workflow'];
      doc.a2Id = doc._id;

      // TODO: check if multisite?
      if (doc.type === 'site') {
        doc.aposDocId = workflow ? doc.workflowGuid : doc._id;
        return doc;
      }

      if (workflow) {
        if (doc.workflowGuid) {
          let locale = doc.workflowLocale.replace('-draft', '');
          locale = self.options.mapLocales[locale] || locale;
          const mode = doc.workflowLocale.endsWith('-draft') ? 'draft' : 'published';
          if (doc.archived && (mode === 'published') && (doc.parkedId !== 'trash')) {
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
          const defaultLocale = self.options.mapLocales.default || 'en';
          doc._id = `${doc._id}:${defaultLocale}:draft`;
          doc.aposDocId = doc._id.split(':')[0];
          doc.aposLocale = `${defaultLocale}:draft`;
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
    self.upgradeSiteLocales = async doc => {
      const hasLocales = Array.isArray(doc.locales);
      if (!hasLocales) {
        return doc;
      }

      const canLocalesBeMapped = doc.locales.every(({ name, label }) => {
        return typeof name === 'string' && typeof label === 'string' && name.length && label.length;
      });
      if (!canLocalesBeMapped) {
        return doc;
      }

      const defaultLocale = self.options.mapLocales.default || 'en';
      const defaultLocaleItem = {
        name: defaultLocale,
        label: defaultLocale,
        prefix: '',
        separateHost: false,
        separateProductionHostname: '',
        private: false
      };

      const mappedLocaleItems = doc.locales.map(({ name, label }) => {
        const mappedName = self.options.mapLocales[name];

        // If provided, use mapped name in the name and the prefix:
        return {
          name: mappedName || name,
          label: mappedName ? `${label} (mapped to ${mappedName})` : label,
          prefix: `/${mappedName || name}`,
          separateHost: false,
          separateProductionHostname: '',
          private: false
        };
      });

      self.localesFound = self.localesFound || {};
      self.localesFound[`${doc._id} (${doc.title})`] = doc.locales.map(({ name }) => {
        const mappedName = self.options.mapLocales[name];
        return mappedName ? `${name} ==> ${mappedName}` : name;
      });

      doc.locales = [ defaultLocaleItem, ...mappedLocaleItems ];

      return doc;
    };
    self.upgradePage = async doc => {
      const a2Path = doc.path;
      if (doc.path !== '/') {
        const a2ParentPath = a2Path.replace(/\/[^/]+$/, '') || '/';
        doc.path = `${self.a2ToA3Paths.get(a2ParentPath)}/${doc.aposDocId}`;
      } else {
        doc.path = doc.aposDocId;
      }
      self.a2ToA3Paths.set(a2Path, doc.path);
      const workflow = self.apos.modules['apostrophe-workflow'];
      if (!workflow) {
        return doc;
      }
      if (workflow.prefixes) {
        const prefix = workflow.prefixes[workflow.liveify(doc.workflowLocale)];
        if (prefix && doc.slug.startsWith(prefix)) {
          doc.slug = doc.slug.substring(prefix.length);
        }
      }
      return doc;
    };
    self.upgradeObject = async (schema, object, options) => {
      for (const field of schema) {
        if (self.upgradeFieldTypes[field.type]) {
          object = await self.upgradeFieldTypes[field.type](object, field, options);
        }
      }
      return object;
    };
    self.upgradeWidget = async widget => {
      widget.metaType = 'widget';
      const manager = self.apos.areas.getWidgetManager(widget.type);
      if (!manager) {
        return false;
      }
      widget = await self.upgradeObject(manager.schema, widget, {
        scopedArrayBase: `widget.${widget.type}`
      });
      if (self.options.transformWidget) {
        widget = await self.options.transformWidget(widget);
        if (!widget) {
          return;
        }
      }
      const mapping = self.options.mapWidgetTypes && self.options.mapWidgetTypes[widget.type];
      if (mapping) {
        if ((typeof mapping) === 'string') {
          return {
            ...widget,
            type: mapping
          };
        } else {
          widget = await mapping(widget);
          if (!widget) {
            return;
          }
        }
      }
      return widget;
    };
    self.upgradeFieldTypes = {
      async joinByOne(doc, field, options) {
        doc[`${field.name.replace(/^_/, '')}Ids`] = doc[field.idField] ? [ doc[field.idField] ] : [];
        return doc;
      },
      async array(doc, field, options) {
        const newArray = [];
        for (const object of (doc[field.name] || [])) {
          newArray.push({
            ...await self.upgradeObject(field.schema, object, options),
            metaType: 'arrayItem',
            scopedArrayName: `${options.scopedArrayBase}.${field.name}`
          });
        }
        doc[field.name] = newArray;
        return doc;
      },
      async object(doc, field, options) {
        if (doc[field.name]) {
          doc[field.name] = [
            {
              ...await self.upgradeObject(field.schema, doc[field.name]),
              metaType: 'arrayItem',
              scopedArrayName: `${options.scopedArrayBase}.${field.name}`
            }
          ];
        }
        return doc;
      },
      async singleton(doc, field, options) {
        return self.upgradeFieldTypes.area(doc, field, options);
      },
      async area(doc, field, options) {
        if (doc[field.name]) {
          const area = doc[field.name];
          area.metaType = 'area';
          area._id = self.apos.utils.generateId();
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
          if (!Array.isArray(object)) {
            if (self.a2ToA3Ids.has(key) && (self.a2ToA3Ids.get(key) !== key)) {
              patchKeys[key] = self.a2ToA3Ids.get(key);
            }
          }
          if (object[key]) {
            if ((object[key] != null) && ((typeof object[key]) === 'object')) {
              let passDebug = false;
              modified = rewrite(object[key], passDebug) || modified;
            } else if (self.a2ToA3Ids.has(object[key]) && self.a2ToA3Ids.get(object[key]) !== object[key]) {
              object[key] = self.a2ToA3Ids.get(object[key]);
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
    // Recursively add any widget types found in object to the set of
    // widget types known to be in the output. Expects an A3 object
    // (relies on metaType).
    self.markWidgetTypesFound = object => {
      if (object.metaType === 'widget') {
        self.widgetTypesFound.add(object.type);
      }
      for (const val of Object.values(object)) {
        if (val && ((typeof val) === 'object')) {
          self.markWidgetTypesFound(val);
        }
      }
    };
    self.report = () => {
      console.log('\nComplete!\n');
      if (self.localesFound) {
        console.log('Locales found and mapped for following site piece(s):\n');
        Object.entries(self.localesFound).forEach(([ site, locales ]) => {
          locales.length && console.log(site, `\n  - ${locales.join('\n  - ')}`);
        });
        console.log('\n');
      }
      console.log('Doc types inserted:\n');
      console.log([...self.docTypesFound].sort().join('\n'));
      console.log('\nWidget types inserted:\n');
      console.log([...self.widgetTypesFound].sort().join('\n'));
    };
  }
};

function fail(message) {
  console.error(`\n\n🛑 ${message}\n`);
  process.exit(1);
}

// Log the value and return it. This is handy in
// arrow functions, to avoid being forced into
// using a function body just because of logging

function log(s) {
  console.log(s);
  return s;
}