---
name: Apostrophe 2.x to 4.x migration
description: Effective patterns for migrating Apostrophe 2.x projects to Apostrophe 4.x
---

# Learn about migration

Always reference the official migration guide:

https://apostrophecms.com/docs/guide/migration/upgrading.html

When migrating, use `web_fetch` to retrieve the latest documentation
and follow those guidelines alongside these patterns.

# Create checkpoint and migration branches

Next, start by creating a `pre-a4` branch representing the original code before the migration. Then create an `a4` branch to work on the migration.

# Common pitfalls

* Remember that in A2, module names are plural but the "type" property (and the "name" option) are singular, while in A4 both are singular for simplicity. Rename modules accordingly. Also don't forget to change core helper calls like `apos.images.first` to `apos.image.first`, etc.
* Change `shortName` by adding `-a4`. This will prevent a conflict between the old and new databases during development. Let the developer worry about content migration.
* Remember to migrate all frontend JS and LESS code to ui/src/index.js and
 ui/src/index.scss files in the appropriate module for each, and to convert LESS to SASS as needed.
* Take note of the differences in Nunjucks syntax, notably apos.area (A2) versus the {% area... %} command (A4), and the need for all areas to be explicitly declared in the index.
* Don't forget `widget.html` templates. In these, handle areas like this: `{% area data.widget, 'areaNameHere' %}`
* `apos.singleton` does not exist in A4. When you encounter it, use `{% area %}`, and make sure the field definition for that area has `max: 1`.
* All macro files and macro invocations that eventually invoke `{% area %}` or `{% component %}` MUST be converted to "fragment" syntax. See: https://apostrophecms.com/docs/reference/template-tags.html#fragment Be sure to use `web_fetch` to review this documentation. Always make sure you use `import` rather than `include` to import fragment definitions into a template. For consistency and to prevent bugs, if you are changing any macros in an imported file to fragments, change ALL of them.
* When converting `joinByOne` fields to `relationship` fields, do not forget that the field's value will be an array. Make sure you access it as an array in templates even if you know there will never be more than one element.
* Don't use "helpers" for area fields. To reuse a set of fields in multiple areas, use `require` to pull in those definitions.
* When migrating from `apostrophe-blog` to `@apostrophecms/blog`, remember that A4 has no standard `event-widget` and `blog-widget` modules. You'll need to implement those.
* Calls to `req.browserCall` are not supported in A4 but you don't need them. Just make sure any needed data is present in attributes in the markup and use `ui/src/index.js` files in relevant modules. Remember that `ui/src/index.js` files must export a function. That function is called once at page load time.
* Some A2 projects have custom webpack or gulp builds. Where possible, migrate that work to `ui/src/index.js` and `ui/src/index.scss` entrypoints in relevant modules.
* Any time you see a core or npm module like `@apostrophecms/user` or `@apostrophecms/event` or `@apostrophecms/search-page` in the project-level `modules` subdirectory, this is a "configuration" aka an "implicit improvement" of the module. It is not a new module. Therefore it must NOT have an `extend` property. If the folder name is different then `extend` does make sense as long as the module being extended is designed for that.
* Every A4 page type must have a corresponding module. A2 page types often do not. Page templates found in `lib/modules/apostrophe-pages/views` must be migrated to `views/page.html` templates in individual modules implementing each page type. By convention these page type modules should have names ending in `-page`. Their area definitions must migrate to a `fields` property in the appropriate module. These modules will extend `@apostrophecms/page-type`. If a page type is already backed explicitly by its own module (typically a `piece-page-type`) then you should find its Nunjucks templates are already in the right place. Don't forget to activate any modules you do add in `app.js`.
* Under no circumstances should you add `fields` to `@apostrophecms/page`, that is the wrong place. That module is a manager for all pages. If the A2 project introduces fields for all page types by configuring `@apostrophecms/custom-pages`, migrate those to `@apostrophecms/page-type`.
* Anything that was originally in lib/modules/apostrophe-global must move to @apostrophecms/global.
* For the `@apostrophecms/rich-text` module: the `sanitizeHtml` option is unnecessary and ignored in A4. In A4 sanitizeHtml is configured automatically based on the elements you permit in a given rich text widget. Remove it.
* Do not attempt to call `req.res.redirect` in event handlers. Instead, set `req.redirect` to a string, allowing ApostropheCMS to process the redirect. You may call `req.res` methods directly in `middleware`.
* If the original frontend code uses jquery, you may `npm install` jquery. Don't forget to `import` jquery into the relevant `ui/src/index.js` files.
* After migration, if an `index.js` file for a module is empty delete it altogether. If it is the only file left in a module subdirectory delete it altogether.
* Watch out for `apos.singleton` calls in templates. `apos.singleton` does not exist in A4. Use `{% area %}`, and make sure the area's definition in the appropriate `fields` property has `max: 1`.
* Watch out for  `apos.area` calls in widget.html templates. Use `{% area %}`. Here the widget is the "document" to be passed as the first argument to `{% area %}`, e.g. `data.widget`.
* Change `.apos-rich-text` to [data-rich-text] in all selectors. 
* Rich text widget configuration must be updated to A4 syntax. `name` becomes `label`, `element` becomes `tag`.
* The `apostrophe-images` widget has been replaced by `@apostrophecms/image`, which supports just one image. Most of the time it was used that way in A2. If the project contains instances of `apostrophe-images` actually being used as a multi-image slideshow, then a project-level slideshow widget must be created to accommodate these and the developer must be instructed to look into content migration issues. However it was more common for projects to have their own project-level slideshow widget which you can port directly.
* The `@apostrophecms/image-widget` module does not set a class on image widgets by default. Set the `className` option at module level, and set appropriate styles to ensure images fill the width given to them 100% but don't overflow.
