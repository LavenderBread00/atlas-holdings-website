import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../',import.meta.url));
const output = resolve(root,'public');
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
for (const path of ['index.html','assets','staff']) await cp(resolve(root,path),resolve(output,path),{recursive:true});
console.log('Prepared the public website and Staff Hub assets for Vercel.');
