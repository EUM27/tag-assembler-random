(function (root, factory) {
  'use strict';

  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.TagAssemblerGenderPolicy = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var AFFINITIES = ['neutral', 'feminine', 'masculine'];
  var RESTRICTIONS = ['none', 'soft', 'strict'];

  function clampConfidence(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }

    return Math.min(1, Math.max(0, value));
  }

  function neutralProfile() {
    return {
      affinity: 'neutral',
      restriction: 'none',
      roleSignal: false,
      confidence: 0,
    };
  }

  function normalizeGenderProfile(option) {
    var source = option && typeof option === 'object' ? option : {};
    var profile = source.genderProfile;

    if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
      var hasValidRestriction = profile.restriction === undefined
        || RESTRICTIONS.includes(profile.restriction);
      var hasValidRoleSignal = profile.roleSignal === undefined
        || typeof profile.roleSignal === 'boolean';
      var hasValidConfidence = profile.confidence === undefined
        || (typeof profile.confidence === 'number' && Number.isFinite(profile.confidence));

      if (
        !AFFINITIES.includes(profile.affinity)
        || !hasValidRestriction
        || !hasValidRoleSignal
        || !hasValidConfidence
      ) {
        return neutralProfile();
      }

      return {
        affinity: profile.affinity,
        restriction: RESTRICTIONS.includes(profile.restriction)
          ? profile.restriction
          : 'none',
        roleSignal: profile.roleSignal === true,
        confidence: clampConfidence(profile.confidence),
      };
    }

    if (source.bias === 'feminine' || source.bias === 'masculine') {
      return {
        affinity: source.bias,
        restriction: 'soft',
        roleSignal: false,
        confidence: 0,
      };
    }

    return neutralProfile();
  }

  function optionFrom(input) {
    if (!input || typeof input !== 'object') {
      return {};
    }

    return input.option && typeof input.option === 'object'
      ? input.option
      : input;
  }

  function bypassesRestrictions(input, option) {
    return Boolean(
      input && (input.unlocked || input.manual || input.pinned)
      || option && (option.unlocked || option.manual || option.pinned)
    );
  }

  function roleFrom(input) {
    return input && (input.role || input.subjectRole);
  }

  function isMixedGlobal(input) {
    if (!input || (input.scope !== 'global' && !input.globalSelection)) {
      return false;
    }

    var subject = input.subject;
    return roleFrom(input) === 'mixed'
      || Boolean(subject && subject.female === true && subject.male === true);
  }

  function isCandidateEligible(input) {
    var option = optionFrom(input);

    if (bypassesRestrictions(input, option)) {
      return true;
    }

    var profile = normalizeGenderProfile(option);

    if (isMixedGlobal(input) && profile.affinity !== 'neutral') {
      return false;
    }

    if (
      roleFrom(input) === '1boy'
      && profile.affinity === 'feminine'
      && profile.restriction === 'strict'
    ) {
      return false;
    }

    return true;
  }

  function numericBaseWeight(input, option) {
    var value = Number(
      input && input.count
      || option.count
      || input && input.weight
      || option.weight
      || 1
    );

    return Number.isFinite(value) ? Math.max(1, value) : 1;
  }

  function effectiveWeight(input) {
    var option = optionFrom(input);
    var base = numericBaseWeight(input, option);

    if (bypassesRestrictions(input, option)) {
      return base;
    }

    if (!isCandidateEligible(input)) {
      return 0;
    }

    var profile = normalizeGenderProfile(option);

    if (
      roleFrom(input) === '1boy'
      && profile.affinity === 'feminine'
      && profile.restriction === 'soft'
    ) {
      return Math.max(Number.EPSILON, base * (1 - profile.confidence));
    }

    return base;
  }

  function isMasculineRoleSignal(option, input) {
    var profile = normalizeGenderProfile(option);

    return profile.affinity === 'masculine'
      && profile.roleSignal
      && isCandidateEligible(Object.assign({}, input, { option: option }));
  }

  function pickRequiredRoleSignal(input) {
    var request = input && typeof input === 'object' ? input : {};

    if (request.unlocked || roleFrom(request) !== '1boy') {
      return null;
    }

    var selected = Array.isArray(request.selected) ? request.selected : [];
    if (selected.some(function (option) {
      return isMasculineRoleSignal(option, request);
    })) {
      return null;
    }

    var candidates = Array.isArray(request.candidates) ? request.candidates : [];
    return candidates.reduce(function (best, candidate) {
      if (!isMasculineRoleSignal(candidate, request)) {
        return best;
      }

      if (!best) {
        return candidate;
      }

      return normalizeGenderProfile(candidate).confidence
        > normalizeGenderProfile(best).confidence
        ? candidate
        : best;
    }, null);
  }

  function subjectRoleWeight(input) {
    var request = input && typeof input === 'object' ? input : {};

    if (request.unlocked) {
      return 1;
    }

    return 1 + clampConfidence(request.opposingConfidence);
  }

  return {
    normalizeGenderProfile: normalizeGenderProfile,
    isCandidateEligible: isCandidateEligible,
    effectiveWeight: effectiveWeight,
    pickRequiredRoleSignal: pickRequiredRoleSignal,
    subjectRoleWeight: subjectRoleWeight,
  };
}));
