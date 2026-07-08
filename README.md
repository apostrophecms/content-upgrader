# @apostrophecms/content-upgrader

A tool to migrate your **content** from Apostrophe 2.x to Apostrophe 4.x. That is, it creates a new database in the A3/A4 format, and copies over the uploaded media. This tool does not upgrade your source code, see our `code-upgrader` module for that.

See also [Coming from Apostrophe 2.x](https://apostrophecms.com/docs/guide/migration/upgrading.html), especially the Breaking Changes section.

## Limitations

* Users and groups are not migrated. This is because the user roles of A3/A4 differ in design from the permissions groups of A2 and we wish to avoid creating any security issues. You should create new accounts on the A4 project or arrive at your own migration strategy.
* A2 has a built-in `apostrophe-images` "slideshow" widget type, while A4 only has a built-in single-image `@apostrophecms/image` widget type. By default `apostrophe-images` will be upgraded to `@apostrophecms/image`, with only the first image present in each. However you can use the `mapWidgetTypes` option, documented below, to override this mapping during the upgrade.
* A4 does not have a standard "piece widget" with support for display of all widgets, handpicked widgets, or tagged widgets in the same way that A2 does. Instead, these are well-documented examples of custom widgets. You will need to use `mapWidgetTypes` accordingly after developing an appropriate solution for your needs in your A4 project.

## BEFORE you use this module

Make sure you take the following steps in your A2 project:

* Be sure to set `parkedId` for any parked pages that do not yet have a `parkedId` in their configuration.
* Then update your apostrophecms modules, especially `apostrophe` which must be updated to the latest in the 2.x series.
* Then run `node app apostrophe-migrations:migrate` to make sure your database is fully up to date.

If you do not take care of these steps, you may get difficult-to-fix errors when following the steps below.

## Installation

This tool installs as a module **inside your existing A2 project.** This is necessary to gain access to information such as the schemas of your existing piece and page and widget types.

```bash
cd my-existing-a2-project
npm install @apostrophecms/content-upgrader
```

## Configuration

Edit `app.js` of your A2 project. Add the module to the `modules` section:

```javascript
modules: {
  // ... all of your existing A2 modules here ...
  '@apostrophecms/content-upgrader': {}
}
```

Then create `lib/modules/@apostrophecms/content-upgrader/index.js`. Here you can optionally address any content transformations and set the default locale, which is important *even if you have no immediate plans to localize your site in other languages.*

### Mapping locales

In A4, "workflow" is always present, and the default locale is `en`. In A2, the default locale of the workflow module is `default` if no other configuration is done.

By default, this module's `mapLocale` option will do the right thing to ensure that typical A2 content is reachable after the migration to A4, but you can adjust this option if needed. here is the default setting:

```javascript
// In lib/modules/@apostrophecms/content-upgrader/index.js
module.exports = {
  mapLocales: {
    default: 'en'
  }
};
```

### Transforming doc types

In A2, the names of piece type modules themselves and the `name` option configured for the module were often different. By convention the piece type module name was plural and the `name` option was singular. The `name` option is what is used in the database to set the `type` property of each piece.

Yes, this was confusing. That's why in A4, the `name` option no longer exists, and **the name of the module and the `type` property in the database are always the same.** Also, by convention, module names in A4 are singular.

What does this mean for us when we upgrade the content? It means that most of the time, **in our A4 source code we need to change the module name to singular and remove its `name` option, but we don't need to change the `type` in the database,** because the new module's name will likely match it.

However, if you *do* want to remap the `type` in the database, perhaps because you're choosing a different name for your module in A4, you can do it like this:

```javascript
module.exports = {
  mapDocTypes: {
    'old-name': 'new-name',
    ...
  }
}
```

🎩 **`old-name` must match the `name` option from the old A2 module,** not the module name from A2. `new-name` must match the module name in your new A4 project, which will also be used for the `type` property.

#### Providing a transformation function

Usually just remapping the name is enough. However if you have designed a new schema for a doc type in your A4 project and you want to migrate the A2 data to that new format, you can supply a transformation function:

```javascript
module.exports = {
  mapDocTypes: {
    // Async functions are allowed and will be awaited
    'old-name': async (doc) => {
      return {
        ...doc,
        // We've decided to change the name
        type: 'new-name',
        // We've changed to a single string field for the address
        address: `${doc.street} ${doc.city}, ${doc.state}`
      };
    }
  }
}
```

🎩 **Your function **must** return a doc unless you want the document to be **removed** in the upgrade.** It's OK to modify the original doc but you must return the modified doc if you want it to be kept.

### Transforming widget types

Just like doc types, in A2 widget `type` properties were set via the `name` option of the widget module in question. This was *set automatically* in most cases based on the module name, **with the `-widgets` part removed.** 

In A4 it is similar, but the `name` option is no longer supported, and the suffix removed from the module name is `-widget`.

For most widgets this means you should not need to remap the type names. You can just rename the module from `-widgets` to `-widget`.

If you choose though, you can rename the types like this:

```javascript
module.exports = {
  mapWidgetTypes: {
    'old-name': 'new-name',
    ...
  }
}
```

#### Transformation functions and pieces-widgets

Keep in mind that **A4 does not have a direct equivalent to `apostrophe-pieces-widgets`. So when you upgrade your code, you'll likely change those widget modules to extend `@apostrophecms/widget-type` and just use a `relationship` schema field to select pieces. The catch is moving the data. A migration function can help you do that:

```javascript
module.exports = {
  mapWidgetTypes: {
    // Async functions are allowed and will be awaited
    'old-name': async (doc) => {
      return {
        ...doc,
        // We've decided to change the name
        type: 'new-name',
        // The old widget extended apostrophe-pieces-widgets, which stores
        // widget ids in a pieceIds property. The new widget has a
        // relationship called _products, which stores them in a
        // productsIds property
        productsIds: doc.pieceIds
      };
    }
  }
}
```

🎩 **Your function **must** return a widget if you want it to be kept in the upgrade.** It's OK to modify the original widget but you must return the modified widget. Otherwise the widget is **removed** in the upgrade.

#### apostrophe-pieces-widgets: "most recent" and "by tag" views

The `apostrophe-pieces-widgets` module also supported "all" and "by tag" displays. Since these were rarely used, they have not been included in A4. If you need to migrate the "all" functionality, we recommend using an [async component](https://apostrophecms.com/docs/guide/async-components.html) to display "all" (typically most recent) pieces in a custom widget. The "by tag" functionality can be addressed in a similar way, however see the note on tags in A4.

🎩 **Your transformation function can return different widget types based on the value of the original `by` property of the pieces-widget.** You're not limited to mapping a 2.x widget type to just one new widget type.

### Tags in A4

In A2, there is always an `apostrophe-tags` module to manage tags, and every piece has an array of tag names in its `tags` property. These all come from the same namespace.

In A4 there is no such type. Instead, you can create new piece types as tags for other piece types and use `relationship` fields to connect your pieces to them. This avoids an explosion of poorly-curated tags and keeps them relevant to the right kind of content.

Many A2 sites don't really use tags. However if you do, keep in mind that the `tags` property remains in the database after the upgrade. Although you could use a global transformation function to convert these to a relationship (see below), it may be easier to do that with a migration in your A4 code after the initial transition to A4.

### Global transformation functions

Most of the time it makes sense to write a transformation function for each doc or widget type. But if you need to address something for every doc and widget, you can write a global transformation function:

```javascript
module.exports = {
  async transformDoc(doc) {
    // This function is invoked for every doc type
    return {
      ...doc,
      // changed properties here
    };
  },
  async transformWidget(widget) {
    // This widget is invoked for every widget type
    return {
      ...widget,
      // changed properties here
    };
  }
}
```

Note that as before, transformation functions **must** return a doc or widget, as appropriate, unless you want it to be **removed** in the upgrade. You can modify the original but you must return it if you wish to keep it.

🎩 **Not all transformations are easiest to achieve during the upgrade. Some might be more easily achieved in A4 after the initial upgrade.** Keep in mind that even if a property is not part of the A4 schema, it will remain in the database.

## Running the upgrade

You'll need a new A4 project to copy the content to. Specify the new project folder and the MongoDB URI of the new A4 database. If you are running MongoDB locally, which is typical during development, you can specify:

```
mongodb://localhost:27017/your-new-database-name
```

🛑 **Don't use the same name as your existing A2 database.** Your new A4 project should also have a different `shortName` setting in `app.js`, for avoidance of any possible confusion. Also make sure your A4 project is not already running, for instance in another terminal window.

```
node app @apostrophecms/content-upgrader:upgrade --a3-db=mongodb://localhost:27017/your-new-database-name
```

## What about the media files?

The media files themselves don't need to change in the transition to A4.

You can copy the `public/uploads` folder from the A2 project to the A4 project manually, or use `rsync`. If you are using uploadfs to store your media in S3 your procedure will vary.

Alternatively, pass `--copy-media` (together with `--a4-dir`) and this tool will copy the media for the migrated attachments for you. This is especially convenient with `--only` and `--related-images`, because only the media for the attachments actually migrated is copied. See the options below.

## Options

### `--a4-db`

**Required.** This must be the MongoDB URI of your new A3/A4 project. By default it will be **cleared and overwritten**. See `--merge` and `--replace` below if you want to add to an existing A4 database instead.

### `--drop`

**Optional.** If at least one Apostrophe doc exists in the new A4 database, the task will exit with an error message unless this option is passed. If the option is passed, existing collections are dropped to start
from scratch. Cannot be combined with `--merge` or `--replace`.

### `--only=type1,type2,...`

**Optional.** Migrate **only** the specified doc types, and only the attachments referenced by those docs. The values are the **A2** `type` names (the same names you would use as keys in `mapDocTypes`), separated by commas.

This is useful for re-migrating a single piece type into an existing A4 database without redoing everything. Combine it with `--merge` or `--replace`, since the target database will already contain data.

🎩 **Attachments (images, files, etc.) are only migrated if a migrated doc references them.** For example, if you want your images to come across, include `apostrophe-image` in the list: `--only=apostrophe-image,article`. The tool does not try to guess which other types your selected types depend on. (See `--related-images` below for a way to bring across just the images your content actually uses.)

Note that relationships/joins pointing to doc types you did **not** include cannot be rewritten to their new ids, because those docs are not part of this migration.

### `--related-images`

**Optional.** Instead of migrating every `apostrophe-image` piece, migrate **only the images actually referenced by the other content being migrated**, along with their attachments. This is handy when your media library contains far more images than your live content uses.

It works on its own — `--related-images` performs a normal full migration but leaves out images nothing refers to — and it composes with `--only`:

* `--only=article,apostrophe-image` migrates every article **and every image**.
* `--only=article --related-images` migrates every article and **only the images those articles reference** (you do not include `apostrophe-image` yourself; it is handled for you).

Only images **directly** referenced by a migrated doc are included (one hop). If an article references some other piece that in turn references an image, and that piece is not itself migrated, its image will not be pulled in. References are resolved against the migrated, A4-form content, so for a legacy `apostrophe-images` slideshow that is reduced to a single-image `@apostrophecms/image` widget, only that one surviving image is considered "referenced".

### `--merge`

**Optional.** Add the upgraded content to the existing A4 database instead of insisting on `--drop`. Existing documents and attachments are left untouched, and the newly upgraded content is inserted alongside them.

If a document or attachment being inserted has the same `_id` as one that already exists, MongoDB will report a duplicate key error. Use `--replace` instead if you want matching documents to be overwritten.

### `--replace`

**Optional.** Like `--merge`, but instead of inserting documents and attachments, it **upserts** them: any existing document or attachment with a matching `_id` is overwritten, and there is no duplicate key error. `--replace` implies `--merge`, so you do not need to pass both.

This is the option to use when re-running an upgrade for a subset of your content, for example `--only=apostrophe-image,article --replace`.

### `--a4-dir=/path/to/a4/project`

**Optional.** The root directory of your new A4 project. Only used by `--copy-media`, to locate the destination `public/uploads/attachments` folder.

### `--copy-media`

**Optional.** Physically copy the media files for the migrated attachments from this A2 project to the A4 project. **Requires `--a4-dir`.**

Only the files for the attachments actually migrated are copied, so this respects `--only` and `--related-images` — a targeted upgrade copies only the media it needs.

🎩 **This option assumes your media is stored locally**, under `public/uploads/attachments`, in both projects. It copies files directly and does **not** go through uploadfs, so it is not suitable for media stored remotely (for example in S3); copy that by your own means. Any migrated attachment whose files are not found locally is reported at the end.

```
node app @apostrophecms/content-upgrader:upgrade \
  --a4-db=mongodb://localhost:27017/your-new-database-name \
  --a4-dir=/path/to/your/a4/project --copy-media
```

## Next steps

After the content migration, you'll be ready to test out your A4 project. Existing local accounts should work properly at this point. The extent to which page and piece templates and settings work will depend on how complete your code upgrade work is.

## If you get errors

If you encounter "duplicate key" errors, you probably don't have a `parkedId` property on every parked page. Manually locate your parked pages in your A2 MongoDB database and set the `parkedId` property appropriately for each. Then try the migration process again.
