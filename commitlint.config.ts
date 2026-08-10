export default {
  extends: ["@commitlint/config-conventional"],
  defaultIgnores: false,
  rules: {
    "body-max-line-length": [0],
    "subject-empty": [2, "never"],
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
        "research",
        "design",
        "governance",
        "plans"
      ]
    ]
  }
};
