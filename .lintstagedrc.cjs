const path = require('path');

// Resolves each staged file relative to the package root so ESLint reads the
// package's eslint.config.* and tsconfig.json from the correct cwd.
const relativeTo = (pkg) => (files) =>
  files.map((f) => path.relative(pkg, f)).join(' ');

module.exports = {
  'backend/**/*.{ts,js}': (files) => [
    `bash -c "cd backend && npx eslint --max-warnings=0 --fix ${relativeTo('backend')(files)}"`,
  ],
  'frontend/**/*.{ts,tsx,js,jsx}': (files) => [
    `bash -c "cd frontend && npx eslint --max-warnings=0 --fix ${relativeTo('frontend')(files)}"`,
  ],
  'desktop/**/*.{ts,js,mjs,cjs}': (files) => [
    `bash -c "cd desktop && npx eslint --max-warnings=0 --fix ${relativeTo('desktop')(files)}"`,
  ],
  'e2e/**/*.{ts,js}': (files) => [
    `bash -c "cd e2e && npx prettier --write ${relativeTo('e2e')(files)}"`,
  ],
};
