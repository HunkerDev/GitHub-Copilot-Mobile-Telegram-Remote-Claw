import { markdownToEntitiesTelegram } from './src/utils/formatter';

const md = `Read [](file:///c%3A/PROALNET/DESARROLLO/TESTING%20BOT%20INSTAGRAM/tasks/0001-prd-merge-csharp.md#1-1), lines 1 to 100`;

const r = markdownToEntitiesTelegram(md);
console.log('TEXT:', JSON.stringify(r.text));
console.log('---ENTITIES---');
r.entities.forEach(e => console.log(JSON.stringify(e)));
