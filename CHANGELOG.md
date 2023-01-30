# Changelog

## UNRELEASED

- Do not create the published version of a draft doc that has `trash: true`.

## 3.0.0-beta.7 (2022-12-14)

- Support for migrating rich text permalinks.

## 3.0.0-beta.6 (2022-12-12)

- Safer migration of site pieces, in case that piece type name is used for something else in a non-multisite project.
- Fixed the link to the document section for migration from Apostrophe 2 in the README.md.

## 3.0.0-beta.5 (2022-11-22)

- Migrate existing locales in site pieces.

## 3.0.0-beta.4 (2022-11-17)

- Do not localize site pieces.

## 3.0.0-beta.3 (2022-11-16)

- Fixed a significant bug preventing proper import of areas when the content has been transformed.
- Allow the `mapWidgetTypes` option to override the standard transformers provided for certain widget types.

## 3.0.0-beta.2 (2022-11-10)

- Correctly update the `path` of each page to the A3 pattern.
- Handle the main "trash" page correctly.
- Fixed a bug that broke the recursive updating of join/relationship ids.

## 3.0.0-beta (2022-02-04)

- Replaced `defaultLocale` option with `mapLocale`, which defaults to mapping `default` to `en`, as that's the right thing to do for projects with or without workflow in most cases, and allows for a broader remapping if needed. Clarified documentation on how this works and implemented it for the case where workflow is enabled for the first time.
- The `visibility` property is now set, as required in A3. If `published` was `true` it is set to `public`, otherwise to `loginRequired`. While the two features are not identical this does a good job of avoiding premature public access to migrated content.
- Don't crash if the workflow module is enabled with no `prefixes` option.
- Supply an `_id` for every exported `area`.
- As the content upgrader intentionally does not copy user and group pieces, it should not copy the `aposUsersSafe` collection from 2.x to 3.x, either.

## 3.0.0-alpha (2021-09-23)

- First alpha test release.
