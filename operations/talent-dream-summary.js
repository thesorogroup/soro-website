/* Existing, private Talent aspirations. No benefit accrual or funding policy. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoroTalentDreamSummary = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const text = value => typeof value === 'string' ? value.trim() : '';
  const escape = value => (typeof value === 'string' ? value : '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

  function authorName(applicant) {
    const first = text(applicant.first_name), last = text(applicant.last_name);
    if (first && last) return `${first} ${last}`;
    const legacy = text(applicant.full_name);
    if (legacy) {
      const parts = legacy.split(',').map(text);
      // Reorder only an unambiguous Last, Given format. Keep every given-name
      // component because a legacy field cannot distinguish middle names.
      return parts.length === 2 && parts.every(Boolean) ? `${parts[1]} ${parts[0]}` : legacy;
    }
    return first || last;
  }

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
    const dream = text(applicant.greatest_dream) ? applicant.greatest_dream : '';
    const author = dream ? authorName(applicant) : '';
    const attribution = author ? `<figcaption class="talent-dream-attribution"><em>— ${escape(author)}</em></figcaption>` : '';
    const quotation = dream ? `<blockquote class="talent-dream-quote"><p class="talent-dream-copy">${escape(dream)}</p></blockquote>` : '';
    let story = dream ? `<figure class="talent-dream-quotation">${quotation}${attribution}</figure>`
      : `<p class="talent-dream-copy talent-dream-copy--empty">${selfView ? 'Every dream starts somewhere.' : 'There is a story still to share.'}</p><p class="talent-dream-guidance">${selfView ? 'Share what you’re working toward.' : 'Invite this Talent to share what matters most.'}</p>`;
    if (dream.length > 420) {
      const excerpt = dream.slice(0, 380).replace(/\s+\S*$/, '');
      story = `<figure class="talent-dream-quotation"><details class="talent-dream-story"><summary><q class="talent-dream-copy talent-dream-excerpt">${escape(excerpt)}…</q><span class="talent-dream-read-more">Read Full Dream</span><span class="talent-dream-read-less">Show Less</span></summary>${quotation}</details>${attribution}</figure>`;
    }
    return `<section class="talent-dream-summary" aria-labelledby="talent-dream-title"><div class="talent-dream-main"><div class="talent-dream-statement"><p class="talent-dream-eyebrow"><span aria-hidden="true">✦</span> Dream Pathway</p><h2 id="talent-dream-title">${selfView ? 'My Dream' : 'Dream & Aspirations'}</h2>${story}<p class="talent-dream-privacy">Full Pathway Private · Shared with Talent Management and Administrators</p></div></div><aside class="talent-dream-companion"><span class="talent-dream-spark" aria-hidden="true">✦</span><h3>Your Dream, In Motion</h3>${benefitsAvailable ? '<button type="button" class="button talent-dream-benefits" data-talent-dream-benefits>Benefits & Support <span aria-hidden="true">→</span></button>' : ''}</aside></section>`;
  }
  return Object.freeze({ canView, render });
});
