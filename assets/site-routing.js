(() => {
  const recipientByInquiry = {
    'Business looking to hire talent': 'partners@thesorogroup.com',
    'Virtual assistant looking for opportunities': 'talents@thesorogroup.com',
    'General inquiry': 'contact@thesorogroup.com',
  };

  function setupRecipientRouting(form) {
    const formNameByInquiry = {
      'Business looking to hire talent': 'business-inquiry',
      'Virtual assistant looking for opportunities': 'talent-inquiry',
      'General inquiry': 'general-inquiry',
    };
    let recipient = form.querySelector('input[name="recipient"]');
    if (!recipient) {
      recipient = document.createElement('input');
      recipient.type = 'hidden';
      recipient.name = 'recipient';
      form.appendChild(recipient);
    }

    const inquirySelect = form.querySelector('select[name="inquiry_type"]');
    const updateRecipient = () => {
      recipient.value = recipientByInquiry[inquirySelect?.value] || 'contact@thesorogroup.com';
      const formName = formNameByInquiry[inquirySelect?.value] || form.getAttribute('name') || 'general-inquiry';
      form.setAttribute('name', formName);
      const formNameInput = form.querySelector('input[name="form-name"]');
      if (formNameInput) formNameInput.value = formName;
    };

    inquirySelect?.addEventListener('change', updateRecipient);
    updateRecipient();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      updateRecipient();

      const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
      const originalLabel = submitButton?.value || submitButton?.textContent || '';

      if (submitButton) {
        submitButton.disabled = true;
        if (submitButton.tagName === 'INPUT') submitButton.value = 'Sending...';
        else submitButton.textContent = 'Sending...';
      }

      try {
        const response = await fetch('/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)).toString(),
        });

        if (!response.ok) throw new Error('Form submission failed');
        window.location.assign(form.getAttribute('action') || '/thank-you.html');
      } catch {
        if (submitButton) {
          submitButton.disabled = false;
          if (submitButton.tagName === 'INPUT') submitButton.value = originalLabel;
          else submitButton.textContent = originalLabel;
        }
        window.alert('We could not send your message. Please try again or email us directly.');
      }
    });
  }

  const modal = document.getElementById('soro-contact-modal');
  const openers = document.querySelectorAll('.soro-popup-trigger');
  const close = modal?.querySelector('.soro-modal-close');
  const menuToggle = document.querySelector('.soro-menu-toggle');
  const mobileMenu = menuToggle
    ? document.getElementById(menuToggle.getAttribute('aria-controls'))
    : null;
  let modalOpener = null;

  function closeMobileMenu() {
    menuToggle?.setAttribute('aria-expanded', 'false');
    menuToggle?.setAttribute('aria-label', 'Open navigation');
    menuToggle?.setAttribute('title', 'Open navigation');
    mobileMenu?.classList.remove('is-open');
  }

  menuToggle?.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isOpen));
    menuToggle.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
    menuToggle.setAttribute('title', isOpen ? 'Open navigation' : 'Close navigation');
    mobileMenu?.classList.toggle('is-open', !isOpen);
  });

  mobileMenu?.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', closeMobileMenu);
  });

  function openModal(event) {
    event.preventDefault();
    modalOpener = event.currentTarget;
    modal?.classList.add('is-open');
    modal?.setAttribute('aria-hidden', 'false');
    close?.focus();
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    modal?.classList.remove('is-open');
    modal?.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    modalOpener?.focus();
    modalOpener = null;
  }

  openers.forEach((opener) => opener.addEventListener('click', openModal));
  close?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal?.classList.contains('is-open')) {
      event.preventDefault();
      closeModal();
    }
    if (event.key === 'Escape') closeMobileMenu();

    if (event.key === 'Tab' && modal?.classList.contains('is-open')) {
      const focusable = Array.from(modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.hasAttribute('hidden'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  document.querySelectorAll('textarea[maxlength]').forEach((textarea) => {
    const counter = document.querySelector(`[data-counter-for="${textarea.id}"]`);
    const update = () => {
      if (counter) counter.textContent = String(textarea.value.length);
    };
    textarea.addEventListener('input', update);
    update();
  });

  function setupRoleFinder(finder) {
    const tabs = Array.from(finder.querySelectorAll('[role="tab"]'));
    const panels = Array.from(finder.querySelectorAll('[role="tabpanel"]'));

    function activateTab(tab, shouldFocus = false) {
      tabs.forEach((item) => {
        const isActive = item === tab;
        item.setAttribute('aria-selected', String(isActive));
        item.tabIndex = isActive ? 0 : -1;
      });

      panels.forEach((panel) => {
        panel.hidden = panel.id !== tab.getAttribute('aria-controls');
      });

      if (shouldFocus) tab.focus();
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateTab(tab));
      tab.addEventListener('keydown', (event) => {
        let nextIndex = index;

        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex === index) return;

        event.preventDefault();
        activateTab(tabs[nextIndex], true);
      });
    });
  }

  document.querySelectorAll('.soro-static-form').forEach(setupRecipientRouting);
  document.querySelectorAll('.soro-biz-role-finder').forEach(setupRoleFinder);
})();
