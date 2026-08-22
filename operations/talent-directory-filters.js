/* Talent Directory filtering and sorting.
   Values are based on recorded profile data only; unverified or missing values
   stay visibly unrecorded instead of being inferred from an uploaded file. */
(function () {
    'use strict';

    var filterState = {
        skill: 'all',
        minYears: 'all',
        workStatus: 'all',
        sort: 'name-asc'
    };

    function text(value) {
        return String(value || '').trim();
    }

    function normalize(value) {
        return text(value).toLocaleLowerCase();
    }

    function title(value) {
        if (typeof window.titleCase === 'function') return window.titleCase(value);
        return text(value).replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
    }

    function escape(value) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
        var node = document.createElement('span');
        node.textContent = value == null ? '' : String(value);
        return node.innerHTML;
    }

    function skillsFor(profile) {
        var sources = [
            profile.verified_skills,
            profile.skills,
            profile.skillsets,
            profile.skills_and_tools,
            profile.skills_and_tools_text
        ];
        var values = [];

        sources.forEach(function (source) {
            if (Array.isArray(source)) {
                values = values.concat(source);
            } else if (source) {
                values = values.concat(String(source).split(/[;,\n|]/));
            }
        });

        return values
            .map(function (skill) { return text(skill); })
            .filter(Boolean)
            .filter(function (skill, index, all) {
                return all.findIndex(function (candidate) {
                    return normalize(candidate) === normalize(skill);
                }) === index;
            });
    }

    function yearsFor(profile) {
        var value = profile.relevant_experience_years;
        if (value == null || value === '') value = profile.years_of_experience;
        if (value == null || value === '') value = profile.years_experience;
        var result = Number.parseFloat(value);
        return Number.isFinite(result) && result >= 0 ? result : null;
    }

    function yearLabel(years) {
        if (years == null) return '<span class="directory-muted">Not recorded</span>';
        return '<span class="directory-years">' + escape(years % 1 === 0 ? String(years) : years.toFixed(1)) + ' year' + (years === 1 ? '' : 's') + '</span>';
    }

    function sortColumnFor(sort) {
        return String(sort || '').split('-')[0];
    }

    function sortDirectionFor(sort) {
        return String(sort || '').endsWith('-desc') ? 'desc' : 'asc';
    }

    function sortButton(label, column) {
        var active = sortColumnFor(filterState.sort) === column;
        var direction = sortDirectionFor(filterState.sort);
        var icon = active ? (direction === 'asc' ? '↑' : '↓') : '↕';
        return '<button class="directory-sort-button ' + (active ? 'is-active' : '') + '" type="button" data-talent-sort="' + column + '" aria-label="Sort by ' + escape(label) + '" aria-pressed="' + active + '">' +
            escape(label) + '<span class="directory-sort-indicator" aria-hidden="true">' + icon + '</span></button>';
    }

    function statusOptions(values, selected, allLabel) {
        return '<option value="all">' + escape(allLabel) + '</option>' + values.map(function (value) {
            return '<option value="' + escape(value) + '"' + (value === selected ? ' selected' : '') + '>' + escape(title(value)) + '</option>';
        }).join('');
    }

    function profileSearchText(profile) {
        return [
            profile.full_name,
            profile.email,
            profile.phone,
            profile.location,
            profile.timezone,
            profile.status,
            profile.work_status,
            profile.relevant_experience_summary,
            profile.education_training_summary
        ].concat(skillsFor(profile)).filter(Boolean).join(' ').toLocaleLowerCase();
    }

    function compareProfiles(left, right) {
        var column = sortColumnFor(filterState.sort);
        var direction = sortDirectionFor(filterState.sort) === 'desc' ? -1 : 1;
        var a;
        var b;

        if (column === 'experience') {
            a = yearsFor(left);
            b = yearsFor(right);
            a = a == null ? -1 : a;
            b = b == null ? -1 : b;
            return (a - b) * direction;
        }
        if (column === 'skills') {
            a = skillsFor(left).join(', ');
            b = skillsFor(right).join(', ');
        } else if (column === 'status') {
            a = left.status;
            b = right.status;
        } else if (column === 'work') {
            a = left.work_status;
            b = right.work_status;
        } else if (column === 'location') {
            a = [left.location, left.timezone].filter(Boolean).join(' ');
            b = [right.location, right.timezone].filter(Boolean).join(' ');
        } else if (column === 'readiness') {
            a = typeof window.readinessSummary === 'function' ? window.readinessSummary(left) : 'Profile review';
            b = typeof window.readinessSummary === 'function' ? window.readinessSummary(right) : 'Profile review';
        } else if (column === 'owner') {
            a = left.talent_review_owner_id ? 'Assigned' : 'Unassigned';
            b = right.talent_review_owner_id ? 'Assigned' : 'Unassigned';
        } else {
            a = left.full_name;
            b = right.full_name;
        }
        return text(a).localeCompare(text(b), undefined, { sensitivity: 'base', numeric: true }) * direction;
    }

    function skillMarkup(skills) {
        if (!skills.length) return '<span class="directory-muted">Not recorded</span>';
        return '<span class="directory-skill-list">' + skills.slice(0, 4).map(function (skill) {
            return '<span class="directory-skill-chip">' + escape(skill) + '</span>';
        }).join('') + (skills.length > 4 ? '<span class="directory-skill-chip">+' + (skills.length - 4) + '</span>' : '') + '</span>';
    }

    window.talentDirectory = function () {
        var profiles = Array.isArray(liveApplicants) ? liveApplicants.slice() : [];
        var query = text(talentSearch).toLocaleLowerCase();
        var statuses = Array.from(new Set(profiles.map(function (profile) { return text(profile.status); }).filter(Boolean))).sort();
        var workStatuses = Array.from(new Set(profiles.map(function (profile) { return text(profile.work_status); }).filter(Boolean))).sort();
    var profileSkills = profiles.reduce(function (all, profile) {
            return all.concat(skillsFor(profile));
        }, []);
        var librarySkills = window.soroSkillLibrary && typeof window.soroSkillLibrary.getActiveNames === 'function'
            ? window.soroSkillLibrary.getActiveNames() : [];
        var allSkills = profileSkills.concat(librarySkills);
        var skills = Array.from(new Set(allSkills.map(normalize))).sort().map(function (normalizedSkill) {
            return allSkills.find(function (skill) { return normalize(skill) === normalizedSkill; });
        }).filter(Boolean);
        var minYears = filterState.minYears === 'all' ? null : Number(filterState.minYears);

        profiles = profiles.filter(function (profile) {
            var profileSkills = skillsFor(profile);
            var years = yearsFor(profile);
            var matchesSearch = !query || profileSearchText(profile).includes(query);
            var matchesSkill = filterState.skill === 'all' || profileSkills.some(function (skill) {
                return normalize(skill) === normalize(filterState.skill);
            });
            var matchesYears = minYears == null || (years != null && years >= minYears);
            var matchesStatus = talentStatus === 'all' || profile.status === talentStatus;
            var matchesWorkStatus = filterState.workStatus === 'all' || profile.work_status === filterState.workStatus;
            return matchesSearch && matchesSkill && matchesYears && matchesStatus && matchesWorkStatus;
        }).sort(compareProfiles);

        var rows = profiles.length ? profiles.map(function (profile) {
            var profileSkills = skillsFor(profile);
            var recordedTimeZone = typeof window.recordedTalentTimeZone === 'function'
                ? window.recordedTalentTimeZone(profile)
                : profile.timezone;
            var location = typeof window.formatTalentLocationTimeZone === 'function'
                ? window.formatTalentLocationTimeZone(profile.location, recordedTimeZone)
                : [profile.location, profile.timezone].filter(Boolean).join(' · ') || 'Not recorded';
            var initialsValue = typeof window.initials === 'function' ? window.initials(profile.full_name) : text(profile.full_name).slice(0, 2);
            var readiness = typeof window.readinessSummary === 'function' ? window.readinessSummary(profile) : 'Profile review';
            return '<tr class="talent-row" data-talent-id="' + escape(profile.id) + '" tabindex="0" role="link" aria-label="Open ' + escape(profile.full_name) + ' profile">' +
                '<td><div class="talent-cell"><span class="mini-avatar">' + escape(initialsValue) + '</span><span><strong>' + escape(profile.full_name) + '</strong><small>' + escape(profile.email || 'No email recorded') + '</small></span></div></td>' +
                '<td>' + skillMarkup(profileSkills) + '</td>' +
                '<td>' + yearLabel(yearsFor(profile)) + '</td>' +
                '<td><span class="tag">' + escape(title(profile.status)) + '</span></td>' +
                '<td>' + escape(title(profile.work_status)) + '</td>' +
                '<td>' + escape(location) + '</td>' +
                '<td>' + escape(readiness) + '</td>' +
                '<td>' + (profile.talent_review_owner_id ? 'Assigned' : 'Unassigned') + '</td></tr>';
        }).join('') : '<tr><td class="empty" colspan="8">No Talent profiles match those filters.</td></tr>';

        return '<div class="directory-toolbar panel directory-filters-grid">' +
            '<label class="directory-search"><span>⌕</span><input id="talent-search" type="search" value="' + escape(talentSearch) + '" placeholder="Search Talent by name, email, skill, or location" /></label>' +
            '<label class="directory-filter-control">Skill<select id="talent-skill-filter">' + statusOptions(skills, filterState.skill, 'All skills') + '</select></label>' +
            '<label class="directory-filter-control">Minimum experience<select id="talent-experience-filter"><option value="all">Any experience</option><option value="1"' + (filterState.minYears === '1' ? ' selected' : '') + '>1+ year</option><option value="2"' + (filterState.minYears === '2' ? ' selected' : '') + '>2+ years</option><option value="3"' + (filterState.minYears === '3' ? ' selected' : '') + '>3+ years</option><option value="5"' + (filterState.minYears === '5' ? ' selected' : '') + '>5+ years</option><option value="7"' + (filterState.minYears === '7' ? ' selected' : '') + '>7+ years</option><option value="10"' + (filterState.minYears === '10' ? ' selected' : '') + '>10+ years</option></select></label>' +
            '<label class="directory-filter-control">Application status<select id="talent-status-filter">' + statusOptions(statuses, talentStatus, 'All statuses') + '</select></label>' +
            '<label class="directory-filter-control">Work status<select id="talent-work-status-filter">' + statusOptions(workStatuses, filterState.workStatus, 'All work statuses') + '</select></label>' +
            '<label class="directory-filter-control">Sort by<select id="talent-sort-filter"><option value="name-asc"' + (filterState.sort === 'name-asc' ? ' selected' : '') + '>Name A–Z</option><option value="name-desc"' + (filterState.sort === 'name-desc' ? ' selected' : '') + '>Name Z–A</option><option value="experience-desc"' + (filterState.sort === 'experience-desc' ? ' selected' : '') + '>Experience: most first</option><option value="experience-asc"' + (filterState.sort === 'experience-asc' ? ' selected' : '') + '>Experience: least first</option><option value="skills-asc"' + (filterState.sort === 'skills-asc' ? ' selected' : '') + '>Skills A–Z</option><option value="status-asc"' + (filterState.sort === 'status-asc' ? ' selected' : '') + '>Application status</option><option value="work-asc"' + (filterState.sort === 'work-asc' ? ' selected' : '') + '>Work status</option><option value="location-asc"' + (filterState.sort === 'location-asc' ? ' selected' : '') + '>Location & time zone</option><option value="readiness-asc"' + (filterState.sort === 'readiness-asc' ? ' selected' : '') + '>Readiness</option><option value="owner-asc"' + (filterState.sort === 'owner-asc' ? ' selected' : '') + '>Owner</option></select></label>' +
            '<span class="directory-count">' + profiles.length + ' of ' + liveApplicants.length + ' profiles</span></div>' +
            '<div class="panel table-wrap"><table class="data-table talent-directory-table"><thead><tr>' +
            '<th>' + sortButton('Talent', 'name') + '</th><th>' + sortButton('Skills', 'skills') + '</th><th>' + sortButton('Experience', 'experience') + '</th><th>' + sortButton('Application status', 'status') + '</th><th>' + sortButton('Work status', 'work') + '</th><th>' + sortButton('Location & time zone', 'location') + '</th><th>' + sortButton('Readiness', 'readiness') + '</th><th>' + sortButton('Owner', 'owner') + '</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    };

    function rerenderSearch() {
        var input = document.getElementById('talent-search');
        var cursor = input ? input.selectionStart : null;
        render();
        window.requestAnimationFrame(function () {
            var next = document.getElementById('talent-search');
            if (next) {
                next.focus();
                if (cursor != null) next.setSelectionRange(cursor, cursor);
            }
        });
    }

    document.addEventListener('input', function (event) {
        if (event.target && event.target.id === 'talent-search') {
            event.stopImmediatePropagation();
            talentSearch = event.target.value;
            rerenderSearch();
        }
    }, true);

    document.addEventListener('change', function (event) {
        var target = event.target;
        if (!target) return;
        if (target.id === 'talent-skill-filter') {
            event.stopImmediatePropagation();
            filterState.skill = target.value;
            render();
        } else if (target.id === 'talent-experience-filter') {
            event.stopImmediatePropagation();
            filterState.minYears = target.value;
            render();
        } else if (target.id === 'talent-status-filter') {
            event.stopImmediatePropagation();
            talentStatus = target.value;
            render();
        } else if (target.id === 'talent-work-status-filter') {
            event.stopImmediatePropagation();
            filterState.workStatus = target.value;
            render();
        } else if (target.id === 'talent-sort-filter') {
            event.stopImmediatePropagation();
            filterState.sort = target.value;
            render();
        }
    }, true);

    document.addEventListener('click', function (event) {
        var button = event.target && event.target.closest('[data-talent-sort]');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        var column = button.getAttribute('data-talent-sort');
        var activeColumn = sortColumnFor(filterState.sort);
        var activeDirection = sortDirectionFor(filterState.sort);
        filterState.sort = column + '-' + (activeColumn === column && activeDirection === 'asc' ? 'desc' : 'asc');
        render();
    }, true);

    async function hydrateDirectoryFields(attempt) {
        if (!window.soroSupabase || !Array.isArray(liveApplicants) || !liveApplicants.length) {
            if ((attempt || 0) < 4) window.setTimeout(function () { hydrateDirectoryFields((attempt || 0) + 1); }, 900);
            return;
        }
        var response = await window.soroSupabase.from('applicants')
            .select('id,verified_skills,relevant_experience_years,relevant_experience_summary,education_training_summary');
        if (response.error || !response.data) return;
        var supplemental = new Map(response.data.map(function (profile) { return [profile.id, profile]; }));
        liveApplicants.forEach(function (profile) {
            var extra = supplemental.get(profile.id);
            if (extra) Object.assign(profile, extra);
        });
        if (current === 'vas') render();
    }

    window.setTimeout(hydrateDirectoryFields, 1250);
    window.addEventListener('soro:skill-library-updated', function () {
        if (current === 'vas') render();
    });
}());
