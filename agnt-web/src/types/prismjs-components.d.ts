// Prism's per-language component files are CommonJS side-effects that
// register grammars onto the shared `Prism` global. They have no runtime
// exports we care about, but TypeScript needs declarations to allow
// `import("prismjs/components/prism-X")` calls in the lazy loader.
declare module "prismjs/components/*";
