# Username judgment frequency list

`src/utils/freq50k.ts` vendors the first 50,000 rows of the English 2018 full
frequency list from [FrequencyWords by Hermit Dave](https://github.com/hermitdave/FrequencyWords/tree/525f9b560de45753a5ea01069454e72e9aa541c6/content/2018/en).
The list was generated from the OpenSubtitles 2018 corpus. FrequencyWords licenses
its content under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/);
the vendored selection and wrapper are distributed under those content terms.
The upstream repository separately licenses its code under MIT.

The parser in `src/utils/segment.ts` uses only lowercase alphabetic tokens and
their frequency counts. The vendored file keeps the original top 50,000 rows so
the filtering stays in one place.

To regenerate from the pinned upstream revision, run:

```sh
npm run generate:freq50k
```

To verify that the generated file matches the pinned source, run:

```sh
node scripts/generate-freq50k.mjs --check
```
