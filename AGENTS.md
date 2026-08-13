# Repository Instructions

## Git workflow

- Do not commit directly to `main` unless the user explicitly requests a direct commit and push to `main`.
- Create feature branches using `codex/<short-description>` when starting work from `main`.
- Treat a request to "commit and push" as the complete publication workflow:
  1. validate the intended changes;
  2. commit them on the current feature branch;
  3. push the branch to `origin`;
  4. create a ready-for-review pull request targeting the repository's default branch.
- Create a draft pull request only when the work is incomplete or the user explicitly requests a draft.
- Do not merge pull requests or delete branches unless the user explicitly requests those actions.
- Stage only files that belong to the requested change. Preserve unrelated local modifications.
- Report the branch, commit, validation results, and pull request URL after publishing.
