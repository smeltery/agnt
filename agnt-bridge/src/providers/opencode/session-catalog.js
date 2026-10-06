async function listSessionCatalog(transport) {
  let projects;
  try { projects = (await transport.httpRequest("GET", "/project")).json; } catch (error) {
    if (error.status !== 404) throw error;
    const response = await transport.httpRequest("GET", "/session");
    if (!Array.isArray(response.json)) throw new Error("Invalid session catalog");
    response.json.forEach(transport.remember);
    return response.json;
  }
  if (!Array.isArray(projects)) throw new Error("Invalid project catalog");
  const roots = new Set(projects.flatMap((project) => [project.worktree, ...(project.roots || []), ...(project.directories || [])]).filter(Boolean));
  const batches = roots.size ? await Promise.all([...roots].map(async (root) =>
    (await transport.httpRequest("GET", "/session?scope=project&limit=10000", undefined, root)).json))
    : [(await transport.httpRequest("GET", "/session")).json];
  const sessions = new Map();
  for (const batch of batches) {
    if (!Array.isArray(batch) || batch.length >= 10000) throw new Error("The session catalog is incomplete");
    for (const session of batch) {
      if (!session?.id) throw new Error("A session has no identifier");
      transport.remember(session); sessions.set(session.id, session);
    }
  }
  return [...sessions.values()];
}

module.exports = { listSessionCatalog };
