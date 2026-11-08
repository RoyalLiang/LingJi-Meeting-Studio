import {requireThat,audioSummary} from '../../../packages/records/src/record.mjs';

export const legacyCollectionFields = ['chunks','segments','events'];
export const collectionFields = [...legacyCollectionFields,'jobs','minutesHistory'];
export const documentFields = ['minutes','liveMinutes','insights','learning'];
export const recordBody = value => Object.fromEntries(Object.entries(value).filter(([key]) => !collectionFields.includes(key) && !documentFields.includes(key)));
export const encodedCollections = value => Object.fromEntries(collectionFields.map(field => [field,(value[field] || []).map(item => JSON.stringify(item))]));
export const encodedDocuments = value => Object.fromEntries(documentFields.filter(field => value[field] !== undefined).map(field => [field,JSON.stringify(value[field])]));
export function hydrateCollections(value, rows, documents = {}) {
  const fields = value.$collections === 1 ? legacyCollectionFields : collectionFields;
  requireThat(fields.every(field => value.$counts?.[field] === rows[field]?.length),'storage_corrupt',500);
  const result = {...value,...Object.fromEntries(fields.map(field => [field,rows[field].map(item => JSON.parse(item))]))};
  if (value.$collections === 2) {
    requireThat(Array.isArray(value.$documents) && value.$documents.every(field => documentFields.includes(field) && Object.hasOwn(documents,field)),'storage_corrupt',500);
    for (const field of value.$documents) result[field] = JSON.parse(documents[field]);
  }
  for (const key of ['$collections','$counts','$version','$documents','$offsets','$audio','$audioVersion']) delete result[key];
  return result;
}
export function sameStorageSnapshot(before,after) {
  return before.body === after.body && Object.keys(before.documents).length === Object.keys(after.documents).length && Object.entries(before.documents).every(([field,value]) => after.documents[field] === value) && collectionFields.every(field => before.rows[field].length === after.rows[field].length && before.rows[field].every((item,index) => item === after.rows[field][index]));
}

export function storageHeader(value,rows,documents,version){
  return {...recordBody(value),$collections:2,$audioVersion:2,$version:version,$documents:Object.keys(documents),$counts:Object.fromEntries(collectionFields.map(field=>[field,rows[field].length])),$audio:audioSummary(value)};
}
