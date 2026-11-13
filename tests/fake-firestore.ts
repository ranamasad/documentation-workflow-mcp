/** An in-memory Firestore REST API: documents, batchGet, commit with preconditions and transforms, transactions, listing. */
export function fakeFirestore(projectId: string) {
  const docs = new Map<string, { fields: Record<string, unknown>; updateTime: string }>();
  let clock = 0;
  const prefix = 'projects/' + projectId + '/databases/(default)/documents/';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const document = (path: string) => ({ name: prefix + path, ...docs.get(path)! });
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace('/v1/' + prefix.slice(0, -1), '')).replace(/^\//, '');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith(':beginTransaction')) return json({ transaction: 'tx-' + (++clock) });
    if (path.endsWith(':rollback')) return json({});
    if (path.endsWith(':batchGet')) {
      return json((body.documents as string[]).map(name => { const key = name.replace(prefix, ''); return docs.has(key) ? { found: document(key) } : { missing: name }; }));
    }
    if (path.endsWith(':commit')) {
      for (const write of body.writes) {
        if (write.delete) continue;
        const key = String(write.update.name).replace(prefix, '');
        const existing = docs.get(key);
        if (write.currentDocument?.exists === false && existing) return json({ error: { message: 'already exists' } }, 409);
        if (write.currentDocument?.updateTime && existing?.updateTime !== write.currentDocument.updateTime) return json({ error: { message: 'stale', status: 'FAILED_PRECONDITION' } }, 400);
      }
      const writeResults = [];
      for (const write of body.writes) {
        if (write.delete) { docs.delete(String(write.delete).replace(prefix, '')); writeResults.push({}); continue; }
        const key = String(write.update.name).replace(prefix, '');
        const fields = { ...write.update.fields };
        for (const transform of write.updateTransforms ?? []) fields[transform.fieldPath] = { timestampValue: new Date(1700000000000 + clock).toISOString() };
        const updateTime = 't' + (++clock);
        docs.set(key, { fields, updateTime });
        writeResults.push({ updateTime });
      }
      return json({ writeResults });
    }
    if (docs.has(path)) return json(document(path));
    const listed = [...docs.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/'));
    if (listed.length && !url.searchParams.has('transaction')) return json({ documents: listed.map(document) });
    return json({ error: { message: 'not found' } }, 404);
  };
  return { fetchFake, docs };
}
