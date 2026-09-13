/* Existing, private Talent aspirations. No benefit accrual or funding policy. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoroTalentDreamSummary = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const text = value => typeof value === 'string' ? value.trim() : '';
  const escape = value => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

  function canView(access, applicant, effectiveRole, selfView) {
    if (!applicant || !access || !text(access.user_id) || !text(access.organization_id)
      || text(access.organization_id) !== text(applicant.organization_id)) return false;
    const actual = text(access.role).toLowerCase();
    const effective = text(effectiveRole).toLowerCase();
    const staff = ['admin', 'talent_management'];
    if (!selfView && staff.includes(actual) && staff.includes(effective)) return true;
    return actual === 'virtual_assistant' && effective === 'virtual_assistant' && selfView === true
      && !!text(access.user_id) && text(access.user_id) === text(applicant.auth_user_id);
  }

  function render({ access, applicant, effectiveRole, selfView = false, benefitsAvailable = false } = {}) {
    if (!canView(access, applicant, effectiveRole, selfView)) return '';
    const dream = text(applicant.greatest_dream);
    let story = dream ? `<p class="talent-dream-copy">${escape(dream)}</p>`
      : `<p class="talent-dream-copy talent-dream-copy--empty">${selfView ? 'Every dream starts somewhere.' : 'There is a story still to share.'}</p><p class="talent-dream-guidance">${selfView ? 'Share what you would love to work toward with Talent Management at your next conversation.' : 'No dream has been recorded yet. Ask what matters to this Talent and what they would love to work toward.'}</p>`;
    if (dream.length > 420) {
      const excerpt = dream.slice(0, 380).replace(/\s+\S*$/, '');
      story = `<details class="talent-dream-story"><summary><span class="talent-dream-copy">${escape(excerpt)}…</span><span class="talent-dream-read-more">Read Full Dream</span><span class="talent-dream-read-less">Show Less</span></summary><p class="talent-dream-copy">${escape(dream)}</p></details>`;
    }
    return `<section class="talent-dream-summary" aria-labelledby="talent-dream-title"><div class="talent-dream-main"><p class="talent-dream-eyebrow"><span aria-hidden="true">✦</span> Dream Pathway</p><h2 id="talent-dream-title">${selfView ? 'My Dream' : 'Dream & Aspirations'}</h2>${story}<p class="talent-dream-privacy">Private · Shared with Talent Management and Administrators</p></div><aside class="talent-dream-companion"><span class="talent-dream-spark" aria-hidden="true">✦</span><h3>A Future Worth Building</h3><p>Meaningful work is part of the journey. The people, possibilities, and dreams behind it matter, too.</p>${benefitsAvailable ? '<button type="button" class="button talent-dream-benefits" data-talent-dream-benefits>Benefits & Support <span aria-hidden="true">→</span></button>' : ''}</aside></section>`;
  }
  return Object.freeze({ canView, render });
});
