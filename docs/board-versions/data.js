// Same sample board for every variant. Fields mirror shared/src/types.ts Task.
window.REPOS = { tm: 'task-manager', nest: 'neko-nest', fe: 'neko-frontend' };
window.GROUPS = {
  tl:  { name: 'Timeline view',  color: 1, feature: 'feat: Timeline' },
  ph:  { name: 'Push health',    color: 2 },
  mob: { name: 'Mobile sheets',  color: 3 },
  ord: { name: 'Orders v2 contract', color: 4 },
};
// order inside a group = sortOrder (run order). parentId builds the tree.
window.TASKS = [
  { id:'t1', title:'Timeline view (split)', status:'blocked', group:'tl', parent:null, repo:'tm', phase:null, cost:0.4 },
  { id:'t2', title:'Fold segments from tm_events', status:'done', group:'tl', parent:'t1', repo:'tm', phase:0, cost:3.1 },
  { id:'t3', title:'Tracks layout + lanes', status:'review', group:'tl', parent:'t1', repo:'tm', phase:0, review:'flagged', cost:5.8 },
  { id:'t4', title:'Drag the future (queue drop)', status:'running', group:'tl', parent:'t1', repo:'tm', phase:1, pct:45, live:'editing queue-drop.ts', cost:2.2 },
  { id:'t5', title:'Prediction accuracy replay', status:'queued', group:'tl', parent:'t1', repo:'tm', phase:1 },
  { id:'t6', title:'Scrub + playback', status:'draft', group:'tl', parent:'t4', repo:'tm', phase:1, agent:true },

  { id:'p1', title:'Push preflight per pr repo', status:'review', group:'ph', parent:null, repo:'tm', review:'passed', cost:4.0 },
  { id:'p2', title:'Classify git failures', status:'done', group:'ph', parent:'p1', repo:'tm', agent:true, cost:1.2 },
  { id:'p3', title:'PushHealthBanner (red/amber)', status:'queued', group:'ph', parent:'p1', repo:'tm' },

  { id:'m1', title:'Sheet exit motion', status:'failed', group:'mob', parent:null, repo:'tm', err:'typecheck red', cost:1.9 },
  { id:'m2', title:'Inbox sheet stack', status:'draft', group:'mob', parent:'m1', repo:'tm' },

  { id:'o1', title:'Serve /v2/orders (items[] + status)', status:'running', group:'ord', parent:null, repo:'nest', pct:70, live:'running e2e', cost:6.3 },
  { id:'o2', title:'Adopt /v2/orders on orders page', status:'waiting', group:'ord', parent:'o1', repo:'fe', agent:true, live:'waiting on contract', cost:0.8 },

  { id:'u1', title:'Fix cost rounding on Dashboard', status:'running', group:null, parent:null, repo:'tm', pct:20, live:'reading stats.ts', cost:0.6 },
  { id:'u2', title:'Sentry: null ref in OrderCard', status:'draft', group:null, parent:null, repo:'fe', source:'sentry', agent:true },
  { id:'u3', title:'Bump vite to 7.2', status:'published', group:null, parent:null, repo:'fe', cost:0.9 },
  { id:'u4', title:'Rate limit on /auth/otp', status:'queued', group:null, parent:null, repo:'nest' },
];
// Relations that are not the tree: agent-filed (createdByRun) and dispatches.
window.FILED = [ ['p1','p2'], ['o1','o2'], ['t4','t6'], ['u1','u2'] ];       // filer -> filed
window.DISPATCH = [ ['o1','o2','needs_action','contract ready'], ['p3','p1','fyi','banner tokens'] ];
window.STATUS_ORDER = ['running','waiting','review','blocked','queued','draft','failed','done','published'];
window.byId = id => TASKS.find(t => t.id === id);
window.gcol = g => g ? `var(--tm-group-${GROUPS[g].color})` : 'var(--tm-border-strong)';
window.badge = t => `<span class="badge s-${t.status}">${t.status==='review'&&t.review?('review · '+t.review):t.status}</span>`;
