const { findSourceMap } = require('module');
const { MongoClient } = require('mongodb');
const fsp = require('fs').promises;
const path = require('path');

// The A2 `type` (name option) of image pieces, mapped to `@apostrophecms/image`
// in A4. Used by --related-images to find and skip/collect image docs.
const A2_IMAGE_TYPE = 'apostrophe-image';

module.exports = {
  mapLocales: {
    'default': 'en'
  },
  async afterConstruct(self) {
    self.addUpgradeTask();
  },
  construct(self, options) {
    self.a2ToA4Paths = new Map();
    self.a2ToA4Ids = new Map();
    self.docTypesFound = new Set();
    self.widgetTypesFound = new Set();
    self.options.mapDocTypes = {
      'apostrophe-user': async (doc) => {
        // For now we do not import users. Determining their proper permissions
        // equivalent in A4 is very subjective and they are easy to add back manually
        return false;
      },
      'apostrophe-group': async (doc) => {
        // For now A4 has no direct equivalent
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
      const uri = self.apos.argv['a4-db'] || self.apos.argv['a3-db'];
      if (!uri) {
        fail('You must specify the --a4-db option, which must be a MongoDB URI for the new database');
      }
      const url = new URL(uri);
      if (self.apos.options.shortName === url.pathname.substring(1)) {
        fail('For prevention of data loss, your a4 database name must not match the A2 project shortName.');
      }
      self.client = new MongoClient(uri, { useUnifiedTopology: true });
      await self.client.connect();
      self.docs = self.client.db().collection('aposDocs');
      self.attachments = self.client.db().collection('aposAttachments');
      const count = await self.docs.countDocuments({});
      if (count) {
        if (self.merge) {
          // --merge (or --replace, which implies it): leave the existing
          // content in place and add the upgraded content alongside it.
        } else if (self.apos.argv.drop) {
          const db = self.client.db();
          const collections = await db.listCollections().toArray();
          for (const collection of collections) {
            await db.collection(collection.name).drop();
          }
        } else if (self.only) {
          fail('Your new A4 database already contains data, but you are using --only,\nso adding to it may make sense. Add --merge to insert the selected types,\nor --replace to also overwrite existing docs of those types.');
        } else {
          fail('Your new A4 database already contains data.\nIf you are comfortable DELETING that data for a fresh upgrade attempt,\nrun again with: --drop.\nTo instead add to the existing content, use --merge (or --replace to\noverwrite docs with matching ids).');
        }
      }
    };
    self.addUpgradeTask = () => {
      self.addTask('upgrade', 'Upgrade content for A4', self.upgradeTask);
    };
    self.parseOptions = (argv) => {
      self.replace = !!argv.replace;
      // --replace implies --merge: upserting into a database only makes sense
      // when we are keeping the content that is already there
      self.merge = !!argv.merge || self.replace;
      if (self.merge && argv.drop) {
        fail('The --drop option cannot be combined with --merge or --replace.\n--drop wipes the database; the others add to or overwrite existing content.');
      }
      if (argv.only === true) {
        fail('The --only option requires a comma-separated list of A2 doc types,\ne.g. --only=apostrophe-image,article');
      }
      self.only = (typeof argv.only === 'string' && argv.only.trim().length)
        ? argv.only.split(',').map(type => type.trim()).filter(type => type.length)
        : null;
      // Migrate only the image docs actually referenced by the other migrated
      // content, instead of every image. Composes with --only.
      self.relatedImages = !!argv['related-images'];
      // Optionally copy the physical media (public/uploads/attachments) of the
      // migrated attachments into the A4 project directory. Assumes local media.
      self.copyMedia = !!argv['copy-media'];
      self.a4Dir = (typeof argv['a4-dir'] === 'string' && argv['a4-dir'].trim().length)
        ? argv['a4-dir'].trim()
        : null;
      if (self.copyMedia && !self.a4Dir) {
        fail('The --copy-media option requires --a4-dir=/path/to/your/a4/project.');
      }
    };
    self.upgradeTask = async (apos, argv) => {
      self.parseOptions(argv);
      if (self.only) {
        console.log(`Migrating only these doc types (and their attachments):\n  ${self.only.join('\n  ')}\n`);
      }
      if (self.merge) {
        console.log(self.replace
          ? 'Merging into existing content; docs and attachments with matching ids will be replaced.\n'
          : 'Merging into existing content; existing content is preserved.\n');
      }
      if (self.relatedImages) {
        console.log('Migrating only the images referenced by the migrated content (--related-images).\n');
      }
      await self.connectToNewDb();
      if (self.relatedImages) {
        await self.prepareRelatedImages();
      }
      await self.upgradeDocsPass();
      if (self.relatedImages) {
        // Must run after the content is migrated (so we know which images it
        // references) but before the id-rewrite pass (so those images are in
        // a2ToA4Ids when references to them are rewritten).
        await self.upgradeRelatedImages();
      }
      await self.rewriteDocsJoinIdsPass();
      await self.removeSuperfluousDocs();
      await self.upgradeAttachments();
      await self.fixLastPublishedAt();
      await self.report();
    };
    self.upgradeDocsPass = async () => {
      if (!self.merge) {
        await self.docs.deleteMany({});
      }
      let criteria = {};
      if (self.only) {
        // With --related-images, images are handled by their own pass, so drop
        // apostrophe-image from the list even if the user included it.
        const types = self.relatedImages
          ? self.only.filter(type => type !== A2_IMAGE_TYPE)
          : self.only;
        criteria = { type: { $in: types } };
      } else if (self.relatedImages) {
        // Migrate everything except images; referenced images are added after.
        criteria = { type: { $ne: A2_IMAGE_TYPE } };
      }
      const cursor = self.apos.docs.db.find(criteria).sort({
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
    self.removeSuperfluousDocs = async () => {
      const cursor = self.docs.find({});

      while (true) {
        const doc = await cursor.next();

        if (!doc) {
          break;
        }
        if (doc.aposMode !== 'published') {
          continue;
        }

        const [ draft ] = await self.docs.find({ _id: doc._id.replace('published', 'draft') }).toArray();

        if (!draft) {
          continue;
        }
        if (draft.archived && (draft.parkedId !== 'archive')) {
          // Remove the published version of draft documents that are archived,
          // except the root archive page which by convention exists in the
          // published locale
          await self.docs.deleteMany({ _id: doc._id });
        }
      }
    };
    self.upgradeAttachments = async () => {
      if (!self.merge) {
        await self.attachments.deleteMany({});
      }
      const keep = self.attachmentFilter();
      const media = self.copyMedia ? await self.prepareMediaCopy() : null;
      await self.apos.migrations.each(self.apos.attachments.db, {}, 5, async attachment => {
        if (keep && !keep(attachment)) {
          return;
        }
        attachment.archivedDocIds = attachment.trashDocIds;
        delete attachment.trashDocIds;
        if (self.replace) {
          await self.attachments.replaceOne({ _id: attachment._id }, attachment, { upsert: true });
        } else {
          await self.attachments.insertOne(attachment);
        }
        if (media) {
          await self.copyAttachmentMedia(attachment, media);
        }
      });
      if (media) {
        self.reportMediaCopy(media);
      }
    };
    // Validate --a4-dir, index the source attachments directory by attachment
    // id, and ensure the destination directory exists. Returns the context used
    // while copying, or exits with a helpful message if the media is not where
    // --copy-media expects it (i.e. stored locally under public/uploads).
    self.prepareMediaCopy = async () => {
      const rootDir = self.apos.rootDir || process.cwd();
      const sourceDir = path.join(rootDir, 'public', 'uploads', 'attachments');
      const destDir = path.join(self.a4Dir, 'public', 'uploads', 'attachments');
      let dirStat = null;
      try {
        dirStat = await fsp.stat(self.a4Dir);
      } catch (e) {
        // handled below
      }
      if (!dirStat || !dirStat.isDirectory()) {
        fail(`--a4-dir "${self.a4Dir}" is not an existing directory.`);
      }
      if (path.resolve(sourceDir) === path.resolve(destDir)) {
        fail('--a4-dir points at the A2 project itself; there is nothing to copy.\nSpecify your new A4 project directory instead.');
      }
      let entries;
      try {
        entries = await fsp.readdir(sourceDir);
      } catch (e) {
        fail(`Could not read the source media directory:\n  ${sourceDir}\n${e.message}\n--copy-media only supports media stored locally under public/uploads.`);
      }
      // Index every file by attachment id (the portion of the filename before
      // the first hyphen; Apostrophe ids contain no hyphens). Each attachment's
      // original plus its scaled and cropped variants share that id prefix, so
      // this lets us copy them all without re-deriving uploadfs paths.
      const byId = new Map();
      for (const file of entries) {
        const hyphen = file.indexOf('-');
        if (hyphen < 0) {
          continue;
        }
        const id = file.slice(0, hyphen);
        let list = byId.get(id);
        if (!list) {
          list = [];
          byId.set(id, list);
        }
        list.push(file);
      }
      await fsp.mkdir(destDir, { recursive: true });
      console.log(`Copying media from ${sourceDir}\n  to ${destDir} ...`);
      return {
        sourceDir,
        destDir,
        byId,
        filesCopied: 0,
        bytesCopied: 0,
        missing: [],
        failed: []
      };
    };
    // Copy one migrated attachment's files (original, scaled sizes and crops)
    // from the A2 uploads directory to the A4 one.
    self.copyAttachmentMedia = async (attachment, media) => {
      const files = media.byId.get(attachment._id);
      if (!files || !files.length) {
        media.missing.push(attachment._id);
        return;
      }
      for (const file of files) {
        try {
          const from = path.join(media.sourceDir, file);
          const to = path.join(media.destDir, file);
          const { size } = await fsp.stat(from);
          await fsp.copyFile(from, to);
          media.filesCopied++;
          media.bytesCopied += size;
        } catch (e) {
          media.failed.push(e);
        }
      }
    };
    self.reportMediaCopy = (media) => {
      const mb = (media.bytesCopied / (1024 * 1024)).toFixed(1);
      console.log(`\nCopied ${media.filesCopied} media file(s) (${mb} MB) into ${media.destDir}.`);
      if (media.missing.length) {
        console.log(`⚠️  ${media.missing.length} migrated attachment(s) had no files in the source directory.\nIf your A2 media is stored remotely (e.g. S3), copy it by your own means;\n--copy-media only handles media stored locally under public/uploads.`);
      }
      if (media.failed.length) {
        console.log(`⚠️  ${media.failed.length} file(s) could not be copied. First error: ${media.failed[0].message}`);
      }
    };
    // Returns a predicate deciding which attachments to migrate, or null to
    // migrate all of them. An attachment's docIds/trashDocIds hold the original
    // A2 _ids of the docs that reference it.
    self.attachmentFilter = () => {
      if (self.only) {
        // Only attachments referenced by a doc we actually migrated. The keys
        // of a2ToA4Ids are exactly those docs' A2 _ids (referenced images, if
        // any, are in there too).
        const migrated = new Set(self.a2ToA4Ids.keys());
        return attachment => attachmentRefs(attachment).some(id => migrated.has(id));
      }
      if (self.relatedImages) {
        // Full migration minus unreferenced images: drop an attachment only
        // when every doc referencing it is an image we chose not to migrate.
        const skipped = new Set(
          [ ...self.imageA2Ids ].filter(id => !self.relatedImageA2Ids.has(id))
        );
        return attachment => {
          const refs = attachmentRefs(attachment);
          return refs.length ? refs.some(id => !skipped.has(id)) : true;
        };
      }
      return null;
    };
    // Build the set of all A2 image doc ids (and, under workflow, a map from
    // each to its workflowGuid) up front, and prepare the accumulator for the
    // ids actually referenced by migrated content.
    self.prepareRelatedImages = async () => {
      self.imageA2Ids = new Set();
      self.relatedImageA2Ids = new Set();
      self.imageGuidById = new Map();
      const workflow = self.apos.modules['apostrophe-workflow'];
      const cursor = self.apos.docs.db.find({ type: A2_IMAGE_TYPE }).project({
        _id: 1,
        workflowGuid: 1
      });
      while (true) {
        const doc = await cursor.next();
        if (!doc) {
          break;
        }
        self.imageA2Ids.add(doc._id);
        if (workflow && doc.workflowGuid) {
          self.imageGuidById.set(doc._id, doc.workflowGuid);
        }
      }
    };
    // Migrate the image docs referenced by content migrated in upgradeDocsPass.
    self.upgradeRelatedImages = async () => {
      if (!self.relatedImageA2Ids.size) {
        console.log('No images are referenced by the migrated content.\n');
        return;
      }
      const or = [ { _id: { $in: [ ...self.relatedImageA2Ids ] } } ];
      // Under workflow an image exists as several docs (draft/live, per locale)
      // sharing a workflowGuid. Bring them all, so A4 gets complete
      // draft/published pairs rather than only the single id referenced.
      const guids = [ ...new Set(
        [ ...self.relatedImageA2Ids ]
          .map(id => self.imageGuidById.get(id))
          .filter(Boolean)
      ) ];
      if (guids.length) {
        or.push({ workflowGuid: { $in: guids } });
      }
      const cursor = self.apos.docs.db.find({
        type: A2_IMAGE_TYPE,
        $or: or
      });
      let count = 0;
      while (true) {
        const doc = await cursor.next();
        if (!doc) {
          break;
        }
        await self.upgradeDoc(doc);
        count++;
      }
      console.log(`Migrated ${count} referenced image doc(s), out of ${self.imageA2Ids.size} in the source.\n`);
    };
    self.fixLastPublishedAt = async () => {
      console.log('Fixing lastPublishedAt properties (may take a long time)...');
      // A4/A4 is a stickler for this property
      const aposLocales = await self.docs.distinct('aposLocale');
      const locales = [...new Set(aposLocales.map(name => name.split(':')[0]))];
      // TODO mongodb batch operation might be smootehr than Promise.all
      for (const locale of locales) {
        const docs = await self.docs.find({
          aposLocale: `${locale}:published`
        }).project({
          updatedAt: 1,
          createdAt: 1
        }).toArray();
        const promises = docs.map(doc => {
          return self.docs.updateMany({
            aposLocale: {
              $in: [ `${locale}:draft`, `${locale}:published`, `${locale}.previous` ]
            }
          }, {
            $set: {
              lastPublishedAt: doc.updatedAt || doc.createdAt
            }
          });
        });
        await Promise.all(promises);
      }
    };
    self.insertOrReplaceDoc = async doc => {
      if (self.replace) {
        await self.docs.replaceOne({ _id: doc._id }, doc, { upsert: true });
      } else {
        await self.docs.insertOne(doc);
      }
    };
    self.upgradeDoc = async doc => {
      const sourceType = doc.type;
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
      // but the type will need draft/published support in A4
      const replicateToPublished = doc._replicateToPublished;
      delete doc._replicateToPublished;
      // Note which images this (non-image) doc references, so --related-images
      // can migrate just those. Done here, on the fully transformed A4 doc.
      if (self.relatedImages && (sourceType !== A2_IMAGE_TYPE)) {
        self.collectReferencedImageIds(doc, self.imageA2Ids, self.relatedImageA2Ids);
      }
      self.a2ToA4Ids.set(doc.a2Id, doc.aposDocId);
      await self.insertOrReplaceDoc(doc);
      self.docTypesFound.add(doc.type);
      self.markWidgetTypesFound(doc);
      if (replicateToPublished) {
        await self.insertOrReplaceDoc({
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
      if (self.apos.options.multisite && doc.type === 'site') {
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
      // (in A4 they must be added to the schema in the code)
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

      if (self.apos.options.multisite && doc.type === 'site') {
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
        // A4 always has draft/published at a minimum, we have to figure out what types
        // would naturally be exempt without the workflow module to tell us
        const exempt = [ 'apostrophe-user', 'apostrophe-group', 'apostrophe-redirect' ];
        if (!exempt.includes(doc.type)) {
          const defaultLocale = self.options.mapLocales.default || 'en';
          doc._id = `${doc._id}:${defaultLocale}:draft`;
          doc.aposDocId = doc._id.split(':')[0];
          doc.aposLocale = `${defaultLocale}:draft`;
          doc.aposMode = 'draft';
          // The trash page itself *does* get published, oddly enough, or A4 is mad
          if (!(doc.trash && (doc.slug !== '/trash'))) {
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
        doc.path = `${self.a2ToA4Paths.get(a2ParentPath)}/${doc.aposDocId}`;
      } else {
        doc.path = doc.aposDocId;
      }
      self.a2ToA4Paths.set(a2Path, doc.path);
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
        if (object.type === '@apostrophecms/rich-text') {
          // Handle rich text permalinks
          object.permalinkIds = [];
          object.content = (object.content || '').replace(/"#apostrophe-permalink-[^"?]*?\?/g, (match) => {
            const matches = match.match(/apostrophe-permalink-(.*)\?/);
            if (matches) {
              const id = self.a2ToA4Ids.get(matches[1]);
              if (id) {
                object.permalinkIds.push(id);
                console.log(`rewrote permalink now points to ${id}`);
                return `"#apostrophe-permalink-${id}?`;
              } else {
                // No match, leave it alone
                return match;
              }
            }
          });
          return;
        }
        // Handle other references to doc ids anywhere we find them
        let modified = false;
        const patchKeys = {};
        for (const key of Object.keys(object)) {          
          if (key === 'a2Id') {
            continue;
          }
          if (!Array.isArray(object)) {
            if (self.a2ToA4Ids.has(key) && (self.a2ToA4Ids.get(key) !== key)) {
              patchKeys[key] = self.a2ToA4Ids.get(key);
            }
          }
          if (object[key]) {
            if ((object[key] != null) && ((typeof object[key]) === 'object')) {
              let passDebug = false;
              modified = rewrite(object[key], passDebug) || modified;
            } else if (self.a2ToA4Ids.has(object[key]) && self.a2ToA4Ids.get(object[key]) !== object[key]) {
              object[key] = self.a2ToA4Ids.get(object[key]);
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
    // widget types known to be in the output. Expects an A4 object
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
    // Record, into `found`, every id in `candidateIds` (all A2 image ids) that
    // the migrated (A4-form) object references. Mirrors the id positions the
    // rewrite() traversal in rewriteDocJoinIds handles — scalar id fields, the
    // keys of id-keyed relationship maps, and rich text permalinks — with two
    // deliberate exceptions that keep --related-images to "images A4 actually
    // uses": an @apostrophecms/image widget counts only its imageIds (the
    // leftover apostrophe-images pieceIds/relationships are ignored), and rich
    // text counts only permalink targets. Keep in sync with rewrite() if the
    // set of id positions there changes.
    self.collectReferencedImageIds = (object, candidateIds, found) => {
      if (object.type === '@apostrophecms/rich-text') {
        const content = object.content || '';
        const regexp = /apostrophe-permalink-([^"?]+)\?/g;
        let match;
        while ((match = regexp.exec(content))) {
          if (candidateIds.has(match[1])) {
            found.add(match[1]);
          }
        }
        return;
      }
      if (object.type === '@apostrophecms/image') {
        for (const id of (object.imageIds || [])) {
          if (candidateIds.has(id)) {
            found.add(id);
          }
        }
        return;
      }
      for (const key of Object.keys(object)) {
        if (key === 'a2Id') {
          continue;
        }
        if (!Array.isArray(object) && candidateIds.has(key)) {
          found.add(key);
        }
        const value = object[key];
        if (value && ((typeof value) === 'object')) {
          self.collectReferencedImageIds(value, candidateIds, found);
        } else if (((typeof value) === 'string') && candidateIds.has(value)) {
          found.add(value);
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

// The A2 _ids of every doc that references an attachment, whether live or in
// the trash.
function attachmentRefs(attachment) {
  return [ ...(attachment.docIds || []), ...(attachment.trashDocIds || []) ];
}

// Log the value and return it. This is handy in
// arrow functions, to avoid being forced into
// using a function body just because of logging

function log(s) {
  console.log(s);
  return s;
}
