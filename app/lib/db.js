// lib/db.js — data layer for the hosted Tolerance Studio pipeline.
//
// Thin wrappers around supabase-js calls. Column/table names match
// app/migrations/001_init.sql exactly:
//   clients(id, name, slug, created_at)
//   projects(id, client_id, name, started_on, product, description, status,
//            tags jsonb, scenes text, shots jsonb, copy_options jsonb,
//            settings jsonb, created_at)
//   renders(id, project_id, filename, storage_path, stage, checker jsonb,
//            verdict, human_override, created_at)
//   run_log(id, project_id, step, note, created_at)
//
// Load lib/supabase.js first (defines window.sb), then this file.

(function (global) {
  function client() {
    if (!global.sb) throw new Error('lib/supabase.js must be loaded before lib/db.js');
    return global.sb;
  }

  // ---------- clients ----------
  async function listClients() {
    const { data, error } = await client().from('clients').select('*').order('name');
    if (error) throw error;
    return data;
  }

  function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  async function createClient(name) {
    const { data, error } = await client()
      .from('clients')
      .insert({ name, slug: slugify(name) })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // ---------- projects ----------
  async function listProjects() {
    // Owner view: every project, joined with client name for grouping.
    const { data, error } = await client()
      .from('projects')
      .select('*, clients(name, slug)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async function getProject(projectId) {
    const { data, error } = await client()
      .from('projects')
      .select('*, clients(name, slug)')
      .eq('id', projectId)
      .single();
    if (error) throw error;
    return data;
  }

  async function createProject({ clientId, name, product, description, startedOn }) {
    const { data, error } = await client()
      .from('projects')
      .insert({
        client_id: clientId,
        name,
        product: product || null,
        description: description || null,
        started_on: startedOn || new Date().toISOString().slice(0, 10),
        status: 'brief',
        tags: { product: [], creative: [] },
        scenes: '',
        settings: {},
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function saveTags(projectId, tags) {
    const { data, error } = await client()
      .from('projects')
      .update({ tags })
      .eq('id', projectId)
      .select()
      .single();
    if (error) throw error;
    await createRunLogEntry(projectId, 'tags-draft', 'tags saved');
    return data;
  }

  async function saveScenes(projectId, scenesText) {
    const { data, error } = await client()
      .from('projects')
      .update({ scenes: scenesText })
      .eq('id', projectId)
      .select()
      .single();
    if (error) throw error;
    await createRunLogEntry(projectId, 'scenes-draft', 'scenes saved');
    return data;
  }

  async function saveShots(projectId, shots) {
    const { data, error } = await client()
      .from('projects')
      .update({ shots })
      .eq('id', projectId)
      .select()
      .single();
    if (error) throw error;
    await createRunLogEntry(projectId, 'expand', 'shots expanded');
    return data;
  }

  async function saveCopyOptions(projectId, copyOptions) {
    const { data, error } = await client()
      .from('projects')
      .update({ copy_options: copyOptions })
      .eq('id', projectId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function saveStatus(projectId, status) {
    const { data, error } = await client()
      .from('projects')
      .update({ status })
      .eq('id', projectId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function saveReferenceImage(projectId, path) {
    const { data, error } = await client()
      .from('projects')
      .update({ reference_image: path })
      .eq('id', projectId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function saveSettings(projectId, settings) {
    const { data, error } = await client()
      .from('projects')
      .update({ settings })
      .eq('id', projectId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Deletes a project and everything under it: the projects row (cascades
  // to renders + run_log per 001_init.sql's `on delete cascade`), plus every
  // file in storage under <slug>/<projectId>/ — the cascade only clears
  // Postgres rows, not bucket objects, so those have to be removed by hand
  // or they'd sit around unreferenced forever.
  async function deleteProject(project) {
    const slug = project.clients && project.clients.slug;
    if (slug) {
      const areas = ['assets', 'renders', 'composed', 'review', 'delivery'];
      const paths = [];
      for (const area of areas) {
        const prefix = `${slug}/${project.id}/${area}`;
        let files;
        try { files = await listFiles(prefix); } catch (e) { continue; }
        for (const f of files) {
          if (f.id) paths.push(`${prefix}/${f.name}`);
        }
      }
      if (paths.length) {
        const { error: rmErr } = await client().storage.from('projects').remove(paths);
        if (rmErr) throw rmErr;
      }
    }
    const { error } = await client().from('projects').delete().eq('id', project.id);
    if (error) throw error;
  }

  // "sibling projects" for the same client, most recent first — mirrors
  // server.py's client_docs() (reads previous campaigns for continuity).
  async function listSiblingProjects(clientId, excludeProjectId, limit = 2) {
    const { data, error } = await client()
      .from('projects')
      .select('*')
      .eq('client_id', clientId)
      .neq('id', excludeProjectId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }

  // ---------- renders ----------
  async function listRenders(projectId) {
    const { data, error } = await client()
      .from('renders')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at');
    if (error) throw error;
    return data;
  }

  async function upsertRender(projectId, filename, fields) {
    const { data, error } = await client()
      .from('renders')
      .upsert({ project_id: projectId, filename, ...fields }, { onConflict: 'project_id,filename' })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Owner's step-3 approve/reject call — final and sticky. Mirrors server.py's
  // POST /checker-verdict: once human_override is set on a render row, a
  // later checker rerun (see functions/checker.js) must never overwrite it.
  // This function IS the one place allowed to set human_override.
  async function setVerdict(renderId, verdict) {
    if (verdict !== 'approved' && verdict !== 'rejected') {
      throw new Error('verdict must be "approved" or "rejected"');
    }
    const { data, error } = await client()
      .from('renders')
      .update({ human_override: verdict })
      .eq('id', renderId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Checker-side write of the automated verdict. Never touches a row where
  // human_override is already set — same rule as run_checker.py's overridden
  // list, which skips re-sorting anything with a recorded override.
  async function setCheckerResult(renderId, { checker, verdict }) {
    const { data: existing, error: readErr } = await client()
      .from('renders')
      .select('human_override')
      .eq('id', renderId)
      .single();
    if (readErr) throw readErr;
    if (existing && existing.human_override) {
      // Sticky rule: skip silently, same as run_checker.py's `overridden` bucket.
      return existing;
    }
    const { data, error } = await client()
      .from('renders')
      .update({ checker, verdict })
      .eq('id', renderId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // ---------- run_log ----------
  async function createRunLogEntry(projectId, step, note) {
    const { data, error } = await client()
      .from('run_log')
      .insert({ project_id: projectId, step, note: note || null })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function listRunLog(projectId) {
    const { data, error } = await client()
      .from('run_log')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  // ---------- storage (renders bucket 'projects') ----------
  // Path convention per 001_init.sql: <client-slug>/<project-id>/<area>/<file>
  // areas: assets | renders | composed | review | delivery
  function storagePath(clientSlug, projectId, area, filename) {
    return `${clientSlug}/${projectId}/${area}/${filename}`;
  }

  async function uploadFile(path, file) {
    const { data, error } = await client().storage.from('projects').upload(path, file, { upsert: true });
    if (error) throw error;
    return data;
  }

  async function getSignedUrl(path, expiresIn = 3600) {
    const { data, error } = await client().storage.from('projects').createSignedUrl(path, expiresIn);
    if (error) throw error;
    return data.signedUrl;
  }

  // Lists files under a bucket prefix (e.g. `${slug}/${projectId}/assets`).
  // Returns [{name, ...}] — folder placeholders have no id, callers can
  // filter on `f.id` to keep only real files.
  async function listFiles(prefix) {
    const { data, error } = await client().storage.from('projects').list(prefix, { limit: 100 });
    if (error) throw error;
    return data;
  }

  async function removeFiles(paths) {
    if (!paths || !paths.length) return;
    const { error } = await client().storage.from('projects').remove(paths);
    if (error) throw error;
  }

  global.db = {
    listClients,
    createClient,
    listProjects,
    getProject,
    createProject,
    deleteProject,
    saveTags,
    saveScenes,
    saveShots,
    saveCopyOptions,
    saveStatus,
    saveReferenceImage,
    saveSettings,
    listSiblingProjects,
    listRenders,
    upsertRender,
    setVerdict,
    setCheckerResult,
    createRunLogEntry,
    listRunLog,
    storagePath,
    uploadFile,
    getSignedUrl,
    listFiles,
    removeFiles,
  };
})(window);
