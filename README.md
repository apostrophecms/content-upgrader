# @apostrophecms/content-upgrader

A tool to migrate your **content** from Apostrophe 2.x to Apostrophe 3.x. That is, it creates a new database in the A3 format, and copies over the uploaded media. This tool does not upgrade your source code. However notes on some of the relevant code changes you'll need are provided below. See also [Coming from Apostrophe 2.x](https://v3.docs.apostrophecms.org/guide/upgrading.html), especially the Breaking Changes section.

## Stability

**This is an alpha release.** We have not done our own acceptance testing on the output yet. It may be useful to you in A2 migrating sites. Your bug reports and contributions are appreciated.

## Limitations

* As stated this is a content migration tool, not a code migration tool. You will need to make code changes manually to convert an A2 project.
* Users and groups are not migrated. This is because the user roles of A3 differ in design from the permissions groups of A2 and we wish to avoid creating any security issues. You should create new accounts on the A3 project or arrive at your own migration strategy.
* A2 has a built-in `apostrophe-images` "slideshow" widget type, while A3 only has a built-in single-image `@apostrophecms/image` widget type. By default `apostrophe-images` will be upgraded to `@apostrophecms/image`, with only the first image present in each. However you can use the `mapWidgetTypes` option, documented below, to override this mapping during the upgrade.
* Since A3 does not have a built-in cropping feature yet, there is currently no accommodation for it in A3's `@apostrophecms/image` widget type. However an attempt is made to carry over the cropping data in the format which is expected to work in A3 in the near future.

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

In A3, "workflow" is always present, and the default locale is `en`. In A2, the default locale of the workflow module is `default` if no other configuration is done.

By default, this module's `mapLocale` option will do the right thing to ensure that typical A2 content is reachable after the migration to A3, but you can adjust this option if needed. here is the default setting:

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

Yes, this was confusing. That's why in A3, the `name` option no longer exists, and **the name of the module and the `type` property in the database are always the same.** Also, by convention, module names in A3 are singular.

What does this mean for us when we upgrade the content? It means that most of the time, **in our A3 source code we need to change the module name to singular and remove its `name` option, but we don't need to change the `type` in the database,** because the new module's name will likely match it.

However, if you *do* want to remap the `type` in the database, perhaps because you're choosing a different name for your module in A3, you can do it like this:

```javascript
module.exports = {
  mapDocTypes: {
    'old-name': 'new-name',
    ...
  }
}
```

🎩 **`old-name` must match the `name` option from the old A2 module,** not the module name from A2. `new-name` must match the module name in your new A3 project, which will also be used for the `type` property.

#### Providing a transformation function

Usually just remapping the name is enough. However if you have designed a new schema for a doc type in your A3 project and you want to migrate the A2 data to that new format, you can supply a transformation function:

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

In A3 it is similar, but the `name` option is no longer supported, and the suffix removed from the module name is `-widget`.

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

Keep in mind that **A3 does not have a direct equivalent to `apostrophe-pieces-widgets`. So when you upgrade your code, you'll likely change those widget modules to extend `@apostrophecms/widget-type` and just use a `relationship` schema field to select pieces. The catch is moving the data. A migration function can help you do that:

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

The `apostrophe-pieces-widgets` module also supported "all" and "by tag" displays. Since these were rarely used, they have not been included in A3. If you need to migrate the "all" functionality, we recommend using an [async component](https://v3.docs.apostrophecms.org/guide/async-components.html) to display "all" (typically most recent) pieces in a custom widget. The "by tag" functionality can be addressed in a similar way, however see the note on tags in A3.

🎩 **Your transformation function can return different widget types based on the value of the original `by` property of the pieces-widget.** You're not limited to mapping a 2.x widget type to just one new widget type.

### Tags in A3

In A2, there is always an `apostrophe-tags` module to manage tags, and every piece has an array of tag names in its `tags` property. These all come from the same namespace.

In A3 there is no such type. Instead, you can create new piece types as tags for other piece types and use `relationship` fields to connect your pieces to them. This avoids an explosion of poorly-curated tags and keeps them relevant to the right kind of content.

Many A2 sites don't really use tags. However if you do, keep in mind that the `tags` property remains in the database after the upgrade. Although you could use a global transformation function to convert these to a relationship (see below), it may be easier to do that with a migration in your A3 code after the initial transition to A3.

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

🎩 **Not all transformations are easiest to achieve during the upgrade. Some might be more easily achieved in A3 after the initial upgrade.** Keep in mind that even if a property is not part of the A3 schema, it will remain in the database.

## Running the upgrade

You'll need a new A3 project to copy the content to. Specify the new project folder and the MongoDB URI of the new A3 database. If you are running MongoDB locally, which is typical during development, you can specify:

```
mongodb://localhost:27017/your-new-database-name
```

🛑 **Don't use the same name as your existing A2 database.** Your new A3 project should also have a different `shortName` setting in `app.js`, for avoidance of any possible confusion. Also make sure your A3 project is not already running, for instance in another terminal window.

```
node app @apostrophecms/content-upgrader:upgrade --a3-db=mongodb://localhost:27017/your-new-database-name
```

## What about the media files?

The media files themselves don't need to change in the transition to A3.

So you can manually copy the `public/uploads` folder from the A2 project to the A3 project, or use `rsync`. If you are using uploadfs to store your media in S3 your procedure will vary.

This tool may automatically copy the `public/uploadfs` folder in a future update.

## Options

### `--a3-db`

**Required.** This must be the MongoDB URI of your new A3 project. It will be **cleared and overwritten**. Currently there is no support for merging upgrade content with an existing A3 database.

### `--drop`

**Optional.** If at least one Apostrophe doc exists in the new A3 database, the task will exit with an error message unless this option is passed.

## Next steps

After the content migration, you'll be ready to test out your A3 project. Existing local accounts should work properly at this point. The extent to which page and piece templates and settings work will depend on how complete your code upgrade work is.
