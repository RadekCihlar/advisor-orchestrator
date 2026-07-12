import { detectAll } from '../engines/index.js';

export async function cmdProviders(): Promise<void> {
  const results = await detectAll();
  console.log('Detected providers:');
  for (const r of results) {
    console.log(`  ${r.name.padEnd(12)} ${r.available ? '✓' : '✗'}  ${r.detail}`);
  }
}
