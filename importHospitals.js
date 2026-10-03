/**
 * Builds data/medicine/hospitals.json from the official National Health
 * Portal "Hospital Directory" open dataset (data.gov.in, Govt. of India —
 * covers allopathy and AYUSH hospitals, state-wise, with specialties,
 * pincode, phone and website).
 *
 * Usage:
 *   1. Download the state CSV(s) from
 *      https://data.gov.in/catalog/hospital-directory-national-health-portal
 *   2. node scripts/importHospitals.js path/to/file1.csv [file2.csv ...]
 *
 * The result is merged with any existing hospitals.json (de-duplicated by
 * name + pincode). lib/medicineAdvisor.js picks it up automatically.
 *
 * Why not individual doctors? The NMC Indian Medical Register and the
 * AYUSH registers are name-lookups behind a CAPTCHA, not open datasets —
 * the app links users to them to *verify* a doctor instead.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'medicine', 'hospitals.json');

function parseCsv(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i = 0; i < text.length; i++){
    const ch = text[i];
    if(inQuotes){
      if(ch === '"' && text[i + 1] === '"'){ field += '"'; i++; }
      else if(ch === '"') inQuotes = false;
      else field += ch;
    } else if(ch === '"') inQuotes = true;
    else if(ch === ','){ row.push(field); field = ''; }
    else if(ch === '\n' || ch === '\r'){
      if(ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if(row.some(c => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  if(field || row.length){ row.push(field); rows.push(row); }
  return rows;
}

function pick(obj, ...names){
  for(const n of names){
    const key = Object.keys(obj).find(k => k.toLowerCase().replace(/[^a-z]/g, '') === n.toLowerCase().replace(/[^a-z]/g, ''));
    if(key && obj[key] && obj[key].trim()) return obj[key].trim();
  }
  return '';
}

const files = process.argv.slice(2);
if(!files.length){
  console.error('Usage: node scripts/importHospitals.js file.csv [more.csv ...]');
  process.exit(1);
}

let existing = [];
try{ existing = JSON.parse(fs.readFileSync(OUT, 'utf-8')); }catch(e){}
const seen = new Set(existing.map(h => `${h.name}|${h.pincode}`.toLowerCase()));
let added = 0;

for(const file of files){
  const rows = parseCsv(fs.readFileSync(file, 'utf-8').replace(/^﻿/, ''));
  const header = rows.shift();
  for(const r of rows){
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] || ''; });
    const name = pick(o, 'Hospital_Name', 'Hospital Name', 'Name');
    if(!name) continue;
    const rec = {
      name,
      state: pick(o, 'State'),
      district: pick(o, 'District'),
      city: pick(o, 'Subdistrict', 'City', 'Town'),
      pincode: pick(o, 'Pincode', 'Pin'),
      address: pick(o, 'Address_Original_First_Line', 'Address'),
      phone: pick(o, 'Telephone', 'Phone', 'Emergency_Num'),
      category: pick(o, 'Hospital_Category', 'Category'),
      system: pick(o, 'Systems_of_Medicine', 'System of Medicine', 'System'),
      specialties: pick(o, 'Specialties', 'Specialities'),
      website: pick(o, 'Website')
    };
    const key = `${rec.name}|${rec.pincode}`.toLowerCase();
    if(seen.has(key)) continue;
    seen.add(key);
    existing.push(rec);
    added++;
  }
}

fs.writeFileSync(OUT, JSON.stringify(existing));
console.log(`Added ${added} facilities; ${existing.length} total in ${OUT}`);
