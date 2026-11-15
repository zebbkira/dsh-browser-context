/** Official client bundler maps CSS Modules to class-name records. */
declare module '*.module.css' { const classes: Readonly<Record<string, string>>; export default classes }
