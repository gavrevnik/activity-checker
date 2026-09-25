# Repository instructions

- Communicate with the user in Russian unless they request another language.
- Preserve unrelated changes and never publish, delete, or rewrite data without an explicit request.
- The canonical repository is https://github.com/gavrevnik/activity-checker.
- The default branch is `master`.
- The live SQLite database is `../data/activity-checker/activity.sqlite` in the standard `life-stack` layout. `ACTIVITY_DB` may override it.
- Never use the live database in tests. Tests must use in-memory or temporary SQLite databases.
- Keep provider secrets only in the ignored `.env.local`; never include them in source, fixtures, logs, or chat output.
- Update `README.md` when setup, storage, providers, or user-visible behavior changes.
- Before handing off code changes, run `npm test`, `npm run check`, and the relevant focused verification.
