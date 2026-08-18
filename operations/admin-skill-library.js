(function () {
    'use strict';

    var storageKey = 'soro-ops-skill-library';
    var skills = [];
    var loaded = false;
    var dialog;
    var searchTerm = '';

    function normalize(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
    function keyFor(value) { return normalize(value).toLowerCase(); }
    function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]; }); }
    function localSkills() { try { return JSON.parse(window.localStorage.getItem(storageKey) || '[]'); } catch (_) { return []; } }
    function saveLocal() { window.localStorage.setItem(storageKey, JSON.stringify(skills)); }
    function activeNames() { return skills.filter(function (skill) { return skill.is_active !== false; }).map(function (skill) { return skill.name; }).sort(function (a, b) { return a.localeCompare(b); }); }
    function setStatus(message, error) { var node = dialog && dialog.querySelector('.skill-library-status'); if (node) { node.textContent = message || ''; node.classList.toggle('is-error', !!error); } }
    function isAdminPanel() { var heading = document.querySelector('.page-heading h1'); return !!heading && heading.textContent.trim() === 'Admin Panel'; }
    function profileUsage() {
        var usage = {};
        (window.liveApplicants || []).forEach(function (profile) {
            (profile.verified_skills || []).forEach(function (skill) { usage[keyFor(skill)] = (usage[keyFor(skill)] || 0) + 1; });
        });
        return usage;
    }

    async function loadSkills() {
        if (loaded) return skills;
        var fallback = localSkills();
        if (!window.soroSupabase) { skills = fallback; loaded = true; return skills; }
        var response = await window.soroSupabase.from('skill_library').select('id,name,description,is_active,retired_at,created_at').order('name');
        if (response.error) { skills = fallback; loaded = true; return skills; }
        skills = response.data || [];
        saveLocal(); loaded = true;
        return skills;
    }

    function renderRows() {
        var list = dialog.querySelector('.skill-library-list');
        var usage = profileUsage();
        var filtered = skills.filter(function (skill) {
            return !searchTerm || (skill.name + ' ' + (skill.description || '')).toLowerCase().indexOf(searchTerm) !== -1;
        });
        dialog.querySelector('[data-skill-count]').textContent = skills.filter(function (skill) { return skill.is_active !== false; }).length + ' active';
        if (!filtered.length) { list.innerHTML = '<div class="skill-library-empty">No matching skills yet. Add the first one above.</div>'; return; }
        list.innerHTML = filtered.map(function (skill) {
            var used = usage[keyFor(skill.name)] || 0;
            var retired = skill.is_active === false;
            var safeguard = used ? '<span class="skill-library-meta">Used on ' + used + ' Talent profile' + (used === 1 ? '' : 's') + '</span>' : '<span class="skill-library-meta">Not yet used on a Talent profile</span>';
            var actions = retired
                ? '<button class="skill-library-action" data-skill-action="restore" data-skill-id="' + escapeHtml(skill.id) + '">Restore</button>' + (used ? '' : '<button class="skill-library-action danger" data-skill-action="delete" data-skill-id="' + escapeHtml(skill.id) + '">Delete</button>')
                : '<button class="skill-library-action" data-skill-action="retire" data-skill-id="' + escapeHtml(skill.id) + '">' + (used ? 'Retire safely' : 'Retire') + '</button>' + (used ? '' : '<button class="skill-library-action danger" data-skill-action="delete" data-skill-id="' + escapeHtml(skill.id) + '">Delete</button>');
            return '<div class="skill-library-row' + (retired ? ' is-retired' : '') + '"><div class="skill-library-row-copy"><span class="skill-library-name">' + escapeHtml(skill.name) + '</span>' + (skill.description ? '<span class="skill-library-description">' + escapeHtml(skill.description) + '</span>' : '') + safeguard + '</div><span class="skill-library-state">' + (retired ? 'Retired' : 'Active') + '</span><div class="skill-library-actions">' + actions + '</div></div>';
        }).join('');
    }

    async function persistNew(name, description) {
        var localSkill = { id: 'local-' + Date.now(), name: name, description: description, is_active: true };
        if (!window.soroSupabase) { skills.push(localSkill); saveLocal(); return; }
        var response = await window.soroSupabase.from('skill_library').insert({ name: name, description: description || null }).select().single();
        if (response.error) throw response.error;
        skills.push(response.data); saveLocal();
    }
    async function updateSkill(skill, patch) {
        if (!window.soroSupabase || String(skill.id).indexOf('local-') === 0) { Object.assign(skill, patch); saveLocal(); return; }
        var response = await window.soroSupabase.from('skill_library').update(patch).eq('id', skill.id);
        if (response.error) throw response.error;
        Object.assign(skill, patch); saveLocal();
    }
    async function deleteSkill(skill) {
        if (!window.soroSupabase || String(skill.id).indexOf('local-') === 0) { skills = skills.filter(function (entry) { return entry.id !== skill.id; }); saveLocal(); return; }
        var response = await window.soroSupabase.from('skill_library').delete().eq('id', skill.id);
        if (response.error) throw response.error;
        skills = skills.filter(function (entry) { return entry.id !== skill.id; }); saveLocal();
    }
    function notifyChange() { window.dispatchEvent(new CustomEvent('soro:skill-library-updated', { detail: { activeSkills: activeNames() } })); }

    function ensureDialog() {
        if (dialog) return dialog;
        dialog = document.createElement('dialog');
        dialog.className = 'skill-library-dialog';
        dialog.innerHTML = '<div class="skill-library-shell"><div class="skill-library-header"><div><h2>Skill library</h2><p>Manage the skills available for Talent profiles and matching. Retiring a skill hides it for new use while preserving past profile history.</p></div><button class="skill-library-close" type="button" aria-label="Close skill library">×</button></div><form class="skill-library-form"><label class="skill-library-field">Skill name<input name="skill-name" maxlength="100" placeholder="e.g. QuickBooks" required></label><label class="skill-library-field">Optional description<input name="skill-description" maxlength="240" placeholder="e.g. Invoicing and reconciliation"></label><button class="skill-library-add" type="submit">Add skill</button></form><div class="skill-library-toolbar"><input class="skill-library-search" type="search" placeholder="Search the skill library" aria-label="Search the skill library"><small data-skill-count></small></div><div class="skill-library-list"></div><p class="skill-library-status" aria-live="polite"></p></div>';
        document.body.appendChild(dialog);
        dialog.querySelector('.skill-library-close').addEventListener('click', function () { dialog.close(); });
        dialog.querySelector('.skill-library-search').addEventListener('input', function (event) { searchTerm = event.target.value.trim().toLowerCase(); renderRows(); });
        dialog.querySelector('.skill-library-form').addEventListener('submit', async function (event) {
            event.preventDefault();
            var name = normalize(event.currentTarget.elements['skill-name'].value);
            var description = normalize(event.currentTarget.elements['skill-description'].value);
            if (!name) return;
            if (skills.some(function (skill) { return keyFor(skill.name) === keyFor(name); })) { setStatus('That skill already exists in the library.', true); return; }
            setStatus('Adding skill…');
            try { await persistNew(name, description); event.currentTarget.reset(); setStatus('Skill added.'); renderRows(); notifyChange(); } catch (error) { setStatus(error.message || 'Could not add that skill.', true); }
        });
        dialog.querySelector('.skill-library-list').addEventListener('click', async function (event) {
            var button = event.target.closest('[data-skill-action]'); if (!button) return;
            var skill = skills.find(function (entry) { return String(entry.id) === button.getAttribute('data-skill-id'); }); if (!skill) return;
            var action = button.getAttribute('data-skill-action');
            if (action === 'delete' && !window.confirm('Delete "' + skill.name + '" from the skill library? This cannot be undone.')) return;
            setStatus(action === 'delete' ? 'Deleting skill…' : 'Updating skill…');
            try {
                if (action === 'delete') await deleteSkill(skill);
                if (action === 'retire') await updateSkill(skill, { is_active: false, retired_at: new Date().toISOString() });
                if (action === 'restore') await updateSkill(skill, { is_active: true, retired_at: null });
                setStatus(action === 'delete' ? 'Skill deleted.' : action === 'restore' ? 'Skill restored.' : 'Skill retired safely.'); renderRows(); notifyChange();
            } catch (error) { setStatus(error.message || 'Could not update that skill.', true); }
        });
        return dialog;
    }
    async function openLibrary() {
        var modal = ensureDialog(); setStatus('Loading skill library…');
        await loadSkills(); renderRows(); setStatus('');
        if (!modal.open) modal.showModal();
    }
    function syncLauncher() {
        var existing = document.querySelector('#manage-skill-library');
        if (!isAdminPanel()) { if (existing) existing.remove(); return; }
        var actions = document.querySelector('.heading-actions');
        if (!actions || existing) return;
        var button = document.createElement('button');
        button.type = 'button'; button.id = 'manage-skill-library'; button.className = 'button'; button.textContent = 'Manage skills';
        var customize = Array.prototype.slice.call(actions.querySelectorAll('button')).find(function (entry) { return entry.textContent.trim() === 'Customize'; });
        actions.insertBefore(button, customize || null);
    }
    document.addEventListener('click', function (event) { if (event.target.closest('#manage-skill-library')) openLibrary(); });
    new MutationObserver(syncLauncher).observe(document.documentElement, { childList: true, subtree: true });
    window.soroSkillLibrary = { getActiveNames: function () { return activeNames(); }, refresh: async function () { loaded = false; await loadSkills(); return activeNames(); } };
    window.setTimeout(syncLauncher, 50);
    window.setTimeout(function () {
        loadSkills().then(function () { notifyChange(); });
    }, 600);
}());
