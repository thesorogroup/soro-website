/* Semantic presentation helpers for Talent screening results. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroScreeningPresentation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_THRESHOLDS = Object.freeze({
    english: Object.freeze({ lowerMax: 59, middleMax: 79 }),
    internetDownload: Object.freeze({ lowerMax: 24, middleMax: 99, meterMax: 250 }),
    internetUpload: Object.freeze({ lowerMax: 4, middleMax: 24, meterMax: 100 })
  });

  const TIER_COPY = Object.freeze({
    english: Object.freeze({
      low: 'Lower',
      middle: 'Middle',
      high: 'Higher'
    }),
    internetDownload: Object.freeze({
      low: 'Lower reference range',
      middle: 'Standard reference range',
      high: 'Higher reference range'
    }),
    internetUpload: Object.freeze({
      low: 'Lower reference range',
      middle: 'Standard reference range',
      high: 'Higher reference range'
    })
  });

  const MBTI_DESCRIPTIONS = Object.freeze({
    ISTJ: Object.freeze({ dimensions: 'Introversion · Sensing · Thinking · Judging', summary: 'Often described as practical, detail-aware, dependable, and methodical.' }),
    ISFJ: Object.freeze({ dimensions: 'Introversion · Sensing · Feeling · Judging', summary: 'Often described as considerate, observant, dependable, and service-oriented.' }),
    INFJ: Object.freeze({ dimensions: 'Introversion · Intuition · Feeling · Judging', summary: 'Often described as thoughtful, values-led, insightful, and organized.' }),
    INTJ: Object.freeze({ dimensions: 'Introversion · Intuition · Thinking · Judging', summary: 'Often described as strategic, independent, analytical, and systems-focused.' }),
    ISTP: Object.freeze({ dimensions: 'Introversion · Sensing · Thinking · Perceiving', summary: 'Often described as adaptable, practical, observant, and solution-focused.' }),
    ISFP: Object.freeze({ dimensions: 'Introversion · Sensing · Feeling · Perceiving', summary: 'Often described as considerate, flexible, observant, and quietly creative.' }),
    INFP: Object.freeze({ dimensions: 'Introversion · Intuition · Feeling · Perceiving', summary: 'Often described as reflective, imaginative, values-led, and adaptable.' }),
    INTP: Object.freeze({ dimensions: 'Introversion · Intuition · Thinking · Perceiving', summary: 'Often described as curious, analytical, independent, and concept-focused.' }),
    ESTP: Object.freeze({ dimensions: 'Extraversion · Sensing · Thinking · Perceiving', summary: 'Often described as energetic, practical, adaptable, and action-oriented.' }),
    ESFP: Object.freeze({ dimensions: 'Extraversion · Sensing · Feeling · Perceiving', summary: 'Often described as sociable, observant, flexible, and people-focused.' }),
    ENFP: Object.freeze({ dimensions: 'Extraversion · Intuition · Feeling · Perceiving', summary: 'Often described as enthusiastic, imaginative, people-focused, and adaptable.' }),
    ENTP: Object.freeze({ dimensions: 'Extraversion · Intuition · Thinking · Perceiving', summary: 'Often described as inventive, curious, analytical, and possibility-focused.' }),
    ESTJ: Object.freeze({ dimensions: 'Extraversion · Sensing · Thinking · Judging', summary: 'Often described as direct, practical, organized, and results-focused.' }),
    ESFJ: Object.freeze({ dimensions: 'Extraversion · Sensing · Feeling · Judging', summary: 'Often described as supportive, sociable, organized, and service-oriented.' }),
    ENFJ: Object.freeze({ dimensions: 'Extraversion · Intuition · Feeling · Judging', summary: 'Often described as encouraging, people-focused, values-led, and organized.' }),
    ENTJ: Object.freeze({ dimensions: 'Extraversion · Intuition · Thinking · Judging', summary: 'Often described as decisive, strategic, organized, and goal-focused.' })
  });

  function finiteNumber(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function thresholdsFor(kind, overrides) {
    return { ...(DEFAULT_THRESHOLDS[kind] || {}), ...(overrides?.[kind] || {}) };
  }

  function semanticTier(kind, value, overrides) {
    const numeric = finiteNumber(value);
    if (numeric === null) return Object.freeze({ key: 'pending', className: 'screening-tier--pending', label: 'Not recorded' });
    const limits = thresholdsFor(kind, overrides);
    const copy = TIER_COPY[kind] || TIER_COPY.internetDownload;
    const lowerBoundary = (finiteNumber(limits.lowerMax) ?? 0) + 1;
    const middleBoundary = (finiteNumber(limits.middleMax) ?? lowerBoundary) + 1;
    if (numeric < lowerBoundary) return Object.freeze({ key: 'low', className: 'screening-tier--low', label: copy.low });
    if (numeric < middleBoundary) return Object.freeze({ key: 'middle', className: 'screening-tier--middle', label: copy.middle });
    return Object.freeze({ key: 'high', className: 'screening-tier--high', label: copy.high });
  }

  function speedMeterPosition(kind, value, overrides) {
    const numeric = finiteNumber(value);
    if (numeric === null) return null;
    const limits = thresholdsFor(kind, overrides);
    const fallback = DEFAULT_THRESHOLDS[kind] || DEFAULT_THRESHOLDS.internetDownload;
    const maximum = Math.max(1, finiteNumber(limits.meterMax) || fallback.meterMax);
    return Math.max(0, Math.min(100, (numeric / maximum) * 100));
  }

  function speedMeterConfiguration(kind, value, overrides) {
    const limits = thresholdsFor(kind, overrides);
    const fallback = DEFAULT_THRESHOLDS[kind] || DEFAULT_THRESHOLDS.internetDownload;
    const maximum = Math.max(1, finiteNumber(limits.meterMax) || fallback.meterMax);
    return Object.freeze({
      ...semanticTier(kind, value, overrides),
      position: speedMeterPosition(kind, value, overrides),
      lowerBoundary: limits.lowerMax + 1,
      middleBoundary: limits.middleMax + 1,
      lowerStop: Math.max(0, Math.min(100, ((limits.lowerMax + 1) / maximum) * 100)),
      middleStop: Math.max(0, Math.min(100, ((limits.middleMax + 1) / maximum) * 100)),
      maximum
    });
  }

  function mbtiDescriptionFromValue(value) {
    const raw = String(value || '').toUpperCase();
    const match = raw.match(/(?:^|[^A-Z])([EI][NS][FT][JP])(?:-([AT]))?(?=$|[^A-Z])/);
    if (!match || !MBTI_DESCRIPTIONS[match[1]]) return null;
    const modifier = match[2] || '';
    return Object.freeze({
      code: match[1],
      modifier,
      displayedCode: `${match[1]}${modifier ? `-${modifier}` : ''}`,
      modifierLabel: modifier === 'A' ? 'Assertive modifier' : modifier === 'T' ? 'Turbulent modifier' : '',
      ...MBTI_DESCRIPTIONS[match[1]]
    });
  }

  function withoutLabel(value, pattern) {
    return String(value || '').replace(pattern, '').replace(/^\s*[:\-–—]\s*/, '').trim();
  }

  function parsePersonalityResults(value) {
    const raw = String(value || '').trim();
    const results = { disc: '', enneagram: '', mbti: '', mbtiDescription: mbtiDescriptionFromValue(raw) };
    if (!raw) return results;

    raw.split(/[|;\n]+/).map(part => part.trim()).filter(Boolean).forEach(part => {
      if (/^disc\b/i.test(part)) results.disc = withoutLabel(part, /^disc\b/i);
      else if (/^enneagram\b/i.test(part)) results.enneagram = withoutLabel(part, /^enneagram\b/i);
      else if (/^(?:mbti(?:-style)?|personality\s+type)\b/i.test(part)) results.mbti = withoutLabel(part, /^(?:mbti(?:-style)?|personality\s+type)\b/i);
      else if (!results.mbti && mbtiDescriptionFromValue(part)) results.mbti = part;
    });

    if (!results.mbti && results.mbtiDescription) results.mbti = results.mbtiDescription.displayedCode;
    return results;
  }

  const COMPUTER_SPEC_FIELDS = Object.freeze([
    Object.freeze({ key: 'system', label: 'System' }),
    Object.freeze({ key: 'processor', label: 'Processor' }),
    Object.freeze({ key: 'memory', label: 'Memory' }),
    Object.freeze({ key: 'storage', label: 'Storage' }),
    Object.freeze({ key: 'operatingSystem', label: 'Operating system' }),
    Object.freeze({ key: 'other', label: 'Other' })
  ]);

  function computerSpecKeyFromLabel(label) {
    const normalized = String(label || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    if (/^(?:system|device|device type|computer type)$/.test(normalized)) return 'system';
    if (/^(?:processor|cpu)$/.test(normalized)) return 'processor';
    if (/^(?:memory|ram)$/.test(normalized)) return 'memory';
    if (/^(?:storage|drive|disk)$/.test(normalized)) return 'storage';
    if (/^(?:operating system|os)$/.test(normalized)) return 'operatingSystem';
    if (/^(?:other|notes?)$/.test(normalized)) return 'other';
    return '';
  }

  function parseComputerSpecs(value) {
    const result = Object.fromEntries(COMPUTER_SPEC_FIELDS.map(field => [field.key, '']));
    const parts = String(value || '').split(/[|;·\n]+/).map(part => part.trim()).filter(Boolean);
    let positionalIndex = 0;

    parts.forEach(part => {
      const labeled = part.match(/^([^:]+)\s*:\s*(.*)$/);
      const labeledKey = labeled ? computerSpecKeyFromLabel(labeled[1]) : '';
      if (labeledKey) {
        result[labeledKey] = labeled[2].trim();
        return;
      }

      while (positionalIndex < COMPUTER_SPEC_FIELDS.length && result[COMPUTER_SPEC_FIELDS[positionalIndex].key]) positionalIndex += 1;
      if (positionalIndex < COMPUTER_SPEC_FIELDS.length) {
        result[COMPUTER_SPEC_FIELDS[positionalIndex].key] = part;
        positionalIndex += 1;
      }
    });

    return Object.freeze(result);
  }

  function serializeComputerSpecs(values = {}) {
    return COMPUTER_SPEC_FIELDS.map(field => {
      const value = String(values[field.key] || '').trim();
      return value ? `${field.label}: ${value}` : '';
    }).filter(Boolean).join(' | ');
  }

  function serializePersonalityResults(values = {}) {
    return [
      ['DISC', values.disc],
      ['Enneagram', values.enneagram],
      ['MBTI-style', values.mbti]
    ].map(([label, rawValue]) => {
      const value = String(rawValue || '').trim();
      return value ? `${label}: ${value}` : '';
    }).filter(Boolean).join(' | ');
  }

  function firstLabeledNumber(text, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const number = '(\\d[\\d,]*(?:\\.\\d+)?)';
    const unit = '(?:mbps|mb\\/s|mbit\\/s|megabits?\\s+per\\s+second|ms)';
    // Prefer a value immediately before its label. Otherwise a string such as
    // "20.42 Mbps Download - 45.57 Mbps Upload" assigns the following Upload
    // value to Download as well.
    const before = text.match(new RegExp(`${number}\\s*(?:${unit})?\\s*\\b${escaped}\\b`, 'i'));
    if (before) return Number(before[1].replace(/,/g, ''));
    const after = text.match(new RegExp(`\\b${escaped}\\b\\s*(?:speed\\s*)?(?:(?:is|of)\\s*)?[:=\\-]?\\s*${number}`, 'i'));
    return after ? Number(after[1].replace(/,/g, '')) : null;
  }

  function prefixedSpeedPair(text, firstLabel, secondLabel) {
    const number = '(\\d[\\d,]*(?:\\.\\d+)?)';
    const unit = '(?:mbps|mb\\/s|mbit\\/s|megabits?\\s+per\\s+second)';
    const connector = '\\s*(?:speed\\s*)?(?:(?:is|of)\\s*)?[:=\\-]?\\s*';
    const separator = `\\s*(?:${unit})?\\s*(?:[|,;/·–—-]\\s*)?`;
    const match = text.match(new RegExp(`\\b${firstLabel}\\b${connector}${number}${separator}\\b${secondLabel}\\b${connector}${number}`, 'i'));
    if (!match) return null;
    return [Number(match[1].replace(/,/g, '')), Number(match[2].replace(/,/g, ''))];
  }

  function parseInternetSpeed(value) {
    const withoutUrls = String(value || '').replace(/\bhttps?:\/\/\S+/gi, ' ');
    const downloadFirst = prefixedSpeedPair(withoutUrls, 'download', 'upload');
    const uploadFirst = downloadFirst ? null : prefixedSpeedPair(withoutUrls, 'upload', 'download');
    const download = downloadFirst?.[0] ?? uploadFirst?.[1] ?? firstLabeledNumber(withoutUrls, 'download') ?? firstLabeledNumber(withoutUrls, 'down');
    const upload = downloadFirst?.[1] ?? uploadFirst?.[0] ?? firstLabeledNumber(withoutUrls, 'upload') ?? firstLabeledNumber(withoutUrls, 'up');
    const latency = firstLabeledNumber(withoutUrls, 'latency') ?? firstLabeledNumber(withoutUrls, 'ping');
    return Object.freeze({ download, upload, latency });
  }

  return Object.freeze({
    DEFAULT_THRESHOLDS,
    MBTI_DESCRIPTIONS,
    semanticTier,
    speedMeterPosition,
    speedMeterConfiguration,
    mbtiDescriptionFromValue,
    parsePersonalityResults,
    COMPUTER_SPEC_FIELDS,
    parseComputerSpecs,
    serializeComputerSpecs,
    serializePersonalityResults,
    parseInternetSpeed
  });
}));
