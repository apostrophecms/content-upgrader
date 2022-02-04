# Changelog

## 3.0.0-beta (2022-02-04)

- Replaced `defaultLocale` option with `mapLocale`, which defaults to mapping `default` to `en`, as that's the right thing to do for projects with or without workflow in most cases, and allows for a broader remapping if needed. Clarified documentation on how this works and implemented it for the case where workflow is enabled for the first time.
- The `visibility` property is now set, as required in A3. If `published` was `true` it is set to `public`, otherwise to `loginRequired`. While the two features are not identical this does a good job of avoiding premature public access to migrated content.
- Don't crash if the workflow module is enabled with no `prefixes` option.
- Supply an `_id` for every exported `area`.
- As the content upgrader intentionally does not copy user and group pieces, it should not copy the `aposUsersSafe` collection from 2.x to 3.x, either.

## 3.0.0-alpha (2021-09-23)

- First alpha test release.
