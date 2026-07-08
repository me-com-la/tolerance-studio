// lib/supabase.js — Supabase client setup for the hosted Tolerance Studio pipeline.
//
// Plain ES module, no build step. Import supabase-js from a CDN in each HTML
// page BEFORE this file (see any of app/2-project-list.html etc. for the
// exact <script> tag), then import this module with a relative <script type="module">
// or a plain <script> that reads window.supabase (umd build). We use the
// UMD build + window global pattern, same as GitHub/lifeos/index.html, so
// this file works from a plain <script> tag with no bundler.
//
// Anon key is safe to embed client-side — RLS (see app/migrations/001_init.sql)
// is what actually protects data, same pattern as GitHub/lifeos/index.html.

// Standard and Pro now share ONE Supabase project (merged 2026-07-08 — was
// previously a second, isolated "tolerance-studio-composite" project;
// see keys-and-deploy.md's Pro section for the retirement note). Same
// project as app/app/lib/supabase.js.
const SUPABASE_URL = 'https://mqgfosfadmmiqlvuvbcy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1xZ2Zvc2ZhZG1taXFsdnV2YmN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNjA3OTgsImV4cCI6MjA5ODkzNjc5OH0.E9Zj_LRU3Uetrcnv5UTOZ1mjDC7aLqKRbgPqsIypsMQ';

// window.supabase is the UMD global from the CDN script tag:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
// We alias it here so app pages just do:
//   <script src="lib/supabase.js"></script>
// and then use the global `sb` client.
if (typeof window !== 'undefined' && window.supabase && !window.sb) {
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Loaded via a plain <script src="lib/supabase.js"> tag (no type="module"),
// so this file must stay free of ES `export` statements — those are a
// SyntaxError in a classic script and silently abort the whole file,
// which means window.sb never gets created. Everything here is a window
// global on purpose; don't reintroduce import/export without also adding
// type="module" to every page that loads this file.
window.getClient = function getClient() {
  if (typeof window !== 'undefined' && window.sb) return window.sb;
  if (typeof window !== 'undefined' && window.supabase) {
    window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return window.sb;
  }
  throw new Error('supabase-js UMD script not loaded before lib/supabase.js');
};
