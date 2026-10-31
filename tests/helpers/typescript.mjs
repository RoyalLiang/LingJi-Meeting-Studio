import esbuild from 'esbuild';

export const transpileTypeScript = source => esbuild.transformSync(source, {
  loader: 'ts', format: 'esm', target: 'esnext',
}).code;
