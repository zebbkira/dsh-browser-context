/** Official client bundler maps CSS Modules to class-name records. */
declare module '*.module.css' { const classes: Readonly<Record<string, string>>; export default classes }
/** Type-only SDK UI imports include their bundler-owned text assets. */
declare module '*?inline' { const text: string; export default text }
declare module '*?raw' { const text: string; export default text }
