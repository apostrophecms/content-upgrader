# @apostrophecms/content-upgrader

A tool to migrate your content from Apostrophe 2.x to Apostrophe 3.x.

This tool installs as a module **inside your existing A2 project.** It will export content to a separate database for use in a new A3 project.

## Installation

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

### Setting the default locale

In `lib/modules/@apostrophecms/content-upgrader/index.js`, be sure to set the default locale name to match your A3 project. Otherwise your site may appear to have no content after the upgrade.

If no locale configuration at all is done in your A3 project, it will be `en`, so that is the default here as well if you do not specify otherwise.

```javascript
// In lib/modules/@apostrophecms/content-upgrader/index.js
module.exports = {
  defaultLocale: 'fr'
};
```

### Transforming doc types

In A2, the names of piece type modules themselves and the `name` option configured for the module were often different. By convention the piece type module name was plural and the `name` option was singular. The `name` option is what is used in the database to set the `type` property of each piece.

Yes, this was confusing. That's why in A3, the `name` option no longer exists, and **the name of the module and the `type` property in the database are always the same.** Also, by convention, module names in A3 are singular.

What does this mean for us when we upgrade the content? It means that most of the time, **we need to change the module name to singular and remove its `name` option for A3, but we don't need to change the `type` in the database.**

However, if you *do* want to remap the `type` in the database, perhaps because you're choosing a different name for your module in A3, you can do it like this:

```javascript
module.exports = {
  mapDocTypes: {
    'old-name': 'new-name',
    ...
  }
}
```

> `old-name` must match the `name` option from the old A2 module, *not* the module name from A2. `new-name` must match the module name in your new A3 project, which will also be used for the `type` property.

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

> Your function **must** return a doc unless you want the document to be **removed** in the upgrade. It's OK to modify the original doc but you must return the modified doc if you want it to be kept.

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

> Your function **must** return a widget if you want it to be kept in the upgrade. It's OK to modify the original widget but you must return the modified widget. Otherwise the widget is **removed** in the upgrade.

#### apostrophe-pieces-widgets: "most recent" and "by tag" views

The `apostrophe-pieces-widgets` module also supported "all" and "by tag" displays. Since these were rarely used, they have not been included in A3. If you need to migrate the "all" functionality, we recommend using an [async component](https://v3.docs.apostrophecms.org/guide/async-components.html) to display "all" (typically most recent) pieces in a custom widget. The "by tag" functionality can be addressed in a similar way, however see the note on tags in A3.

> 🎩 Your transformation function can return different widget types based on the value of the original `by` property. You're not limited to mapping a 2.x widget type to just one new widget type.

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

> Not all transformations are easiest to achieve during the upgrade. Some might be more easily achieved in A3 after the initial upgrade. Keep in mind that even if a property is not part of the A3 schema, it will remain in the database.

## Running the upgrade

You'll need a new A3 project to copy the content to. Specify both the new project folder and the MongoDB URI of the new A3 database. If you are running MongoDB locally, which is typical during development, you can specify:

```
mongodb://localhost:27017/your-new-database-name
```

> 🛑 Don't use the same name as your existing A2 database. Your new A3 project should also have a different `shortName` setting in `app.js`, for avoidance of any possible confusion. Also make sure your A3 project is not already running, for instance in another terminal window.

```
node app @apostrophecms/content-upgrader:upgrade --a3-project=../your-new-a3-project-folder --a3-db=mongodb://localhost:27017/your-new-database-name
```

## Options

### `--skip-uploads`

By default this tool will also copy media from `public/uploads` to the `public/uploads` folder of the A3 project, using `rsync`. You can skip this step with `--skip-uploads`. Note that **the actual contents of the folder won't change**, so feel free to copy it by other means, especially if you are using AWS S3 for media storage, etc.

## Next steps

After the content migration, you'll be ready to test out your A3 project. Existing local accounts should work properly at this point. The extent to which page and piece templates and settings work will depend on how complete your code upgrade work is.
