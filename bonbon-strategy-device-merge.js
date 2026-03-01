/**
 * bonbon-strategy-device-merge.js
 * ================================
 * Device Merge Module — Aggregates multiple entities under the same device_id
 * into a single composite Bubble Card.
 *
 * Design:
 *   The original bonbon-strategy splits area entities into domain-based sections
 *   (lights, switches, climate, ...). Since each section only contains entities
 *   of ONE domain, grouping by device_id within a single section rarely finds
 *   multi-entity groups — the same device's entities are scattered across sections.
 *
 *   The correct approach is CROSS-SECTION merging by default:
 *     1. Collect ALL entities for the area across all sections
 *     2. Group by device_id
 *     3. Build one merged card per device
 *     4. Assign each merged card to the section of its PRIMARY entity's domain
 *
 * Exports:
 *   - buildAreaDeviceCards(area, sectionKeys, sectionConfigs, mergeMode, ...)
 *       → Map<sectionKey, card[]>   — the main entry point
 *   - buildSectionCards(entities, mergeMode, createButtonCard, createSubButton)
 *       → card[]                    — fallback for single-section use
 */

// ============================================================
// Domain Priority — lower = more likely to be the primary entity
// ============================================================

const DOMAIN_PRIORITY = {
  climate: 1,
  media_player: 2,
  cover: 3,
  light: 4,
  fan: 5,
  humidifier: 6,
  vacuum: 7,
  lawn_mower: 8,
  water_heater: 9,
  switch: 10,
  lock: 11,
  valve: 12,
  input_boolean: 13,
  automation: 14,
  script: 15,
  binary_sensor: 20,
  sensor: 30,
  number: 40,
  select: 40,
  input_number: 40,
  input_select: 40,
  button: 50,
  input_button: 50,
  update: 60,
  device_tracker: 70,
};

// Section key → domain prefixes it collects
const SECTION_DOMAIN_MAP = {
  bonbon_lights: ['light'],
  bonbon_switches: ['switch'],
  bonbon_media: ['media_player'],
  bonbon_climate: ['climate'],
  bonbon_covers: ['cover'],
  bonbon_openings: ['binary_sensor'],
};

function getDomain(entityId) {
  return entityId?.split('.')[0] || '';
}

function getDomainPriority(entityId) {
  return DOMAIN_PRIORITY[getDomain(entityId)] ?? 99;
}

/**
 * Determine which section a domain naturally belongs to.
 */
function sectionForDomain(domain) {
  for (const [secKey, domains] of Object.entries(SECTION_DOMAIN_MAP)) {
    if (domains.includes(domain)) return secKey;
  }
  return 'bonbon_miscellaneous';
}

// ============================================================
// Device Grouping
// ============================================================

function groupByDevice(resolvedEntities) {
  const deviceMap = new Map();
  const noDevice = [];

  for (const c of resolvedEntities) {
    const devId = c.entity?.device_id;
    if (!devId) {
      noDevice.push(c);
      continue;
    }
    if (!deviceMap.has(devId)) {
      deviceMap.set(devId, {
        deviceId: devId,
        device: window.__bonbon?.devices?.[devId] || null,
        entities: [],
      });
    }
    deviceMap.get(devId).entities.push(c);
  }

  for (const [, group] of deviceMap) {
    group.entities.sort(
      (a, b) =>
        getDomainPriority(a.entity?.entity_id) -
        getDomainPriority(b.entity?.entity_id),
    );
    group.primary = group.entities[0];
    group.secondaries = group.entities.slice(1);
  }

  return { deviceMap, noDevice };
}

// ============================================================
// Card Builders
// ============================================================

/**
 * primary mode — main entity as card body, secondaries as top-right sub_buttons
 */
function createMergedCard(group, createButtonCard, createSubButton) {
  const { primary, secondaries, device } = group;

  if (secondaries.length === 0) {
    return createButtonCard(primary);
  }

  const deviceName = device?.name_by_user || device?.name || '';

  const subButtons = secondaries.map((c) =>
    createSubButton(c, {
      show_state: true,
      show_background: false,
      fill_width: false,
    }),
  );

  return createButtonCard(primary, {
    name: deviceName || undefined,
    sub_button: {
      main: [{ group: subButtons }],
    },
    bonbon_styles: ['bubbleDeviceMerged'],
  });
}

/**
 * expanded mode — controllable secondaries → top-right, sensors → bottom row
 */
function createExpandedCard(group, createButtonCard, createSubButton) {
  const { primary, secondaries, device } = group;

  if (secondaries.length === 0) {
    return createButtonCard(primary);
  }

  const deviceName = device?.name_by_user || device?.name || '';

  const sensorEntities = secondaries.filter((c) => {
    const d = getDomain(c.entity?.entity_id);
    return d === 'sensor' || d === 'binary_sensor';
  });

  const controllableEntities = secondaries.filter((c) => {
    const d = getDomain(c.entity?.entity_id);
    return d !== 'sensor' && d !== 'binary_sensor';
  });

  const mainGroup = controllableEntities.length
    ? [
        {
          group: controllableEntities.map((c) =>
            createSubButton(c, {
              show_state: false,
              show_background: true,
              fill_width: false,
            }),
          ),
        },
      ]
    : [];

  const bottomGroup = sensorEntities.length
    ? [
        {
          buttons_layout: 'inline',
          justify_content: 'start',
          group: sensorEntities.map((c) =>
            createSubButton(c, {
              show_state: true,
              show_background: false,
              fill_width: false,
            }),
          ),
        },
      ]
    : [];

  const hasBottom = bottomGroup.length > 0;

  return createButtonCard(primary, {
    name: deviceName || undefined,
    rows: hasBottom ? (secondaries.length > 2 ? 1.6 : 1.3) : 1,
    sub_button: {
      main: mainGroup,
      bottom: bottomGroup,
      bottom_layout: 'inline',
    },
    bonbon_styles: ['bubbleDeviceMerged'],
  });
}

function buildCard(group, mergeMode, createButtonCard, createSubButton) {
  if (mergeMode === 'expanded') {
    return createExpandedCard(group, createButtonCard, createSubButton);
  }
  return createMergedCard(group, createButtonCard, createSubButton);
}

// ============================================================
// MAIN ENTRY: Cross-section device merge for an entire area
// ============================================================

/**
 * Collect all entities for one area, group by device, build merged cards,
 * and distribute them back to the correct section.
 *
 * @param {Object}   area           - area object with _lights, _switches, etc.
 * @param {string[]} sectionKeys    - ordered, enabled section keys
 * @param {Object}   sectionConfigs - config.views.bonbon_area.sections
 * @param {string}   globalMode     - 'primary' | 'expanded' | 'none'
 * @param {Function} getMergeMode   - (sectionConfig) => effective mode
 * @param {Function} createButtonCard
 * @param {Function} createSubButton
 * @returns {Map<string, Array>}    - sectionKey → card array
 */
export function buildAreaDeviceCards(
  area,
  sectionKeys,
  sectionConfigs,
  globalMode,
  getMergeMode,
  createButtonCard,
  createSubButton,
) {
  // Initialize result map
  const result = new Map();
  for (const key of sectionKeys) {
    result.set(key, []);
  }

  // If globally disabled, return empty (caller will fall back to original logic)
  if (globalMode === 'none') {
    return null;
  }

  // 1. Collect all area entities into one flat list, deduped
  //    Also track which entity_id came from which section(s)
  const entityLists = {
    bonbon_climate: area._climates || [],
    bonbon_lights: area._lights || [],
    bonbon_switches: area._switches || [],
    bonbon_media: area._media || [],
    bonbon_covers: area._covers || [],
    bonbon_openings: area._openings || [],
    bonbon_miscellaneous: area._misc || [],
  };

  const allEntities = [];
  const seenIds = new Set();
  // Track the "original section" each entity_id belongs to
  const entityOriginalSection = new Map();

  for (const key of sectionKeys) {
    const list = entityLists[key] || [];
    for (const c of list) {
      const eid = c.entity?.entity_id;
      if (eid && !seenIds.has(eid)) {
        seenIds.add(eid);
        allEntities.push(c);
        entityOriginalSection.set(eid, key);
      }
    }
  }

  // Also filter out entities already in categorizedEntityIds (environment etc.)
  const availableEntities = allEntities.filter(
    (c) => !area.categorizedEntityIds.includes(c.entity?.entity_id),
  );

  // 2. Group by device
  const { deviceMap, noDevice } = groupByDevice(availableEntities);

  // 3. Track which entity_ids we consume (for categorizedEntityIds)
  const consumedIds = new Set();

  // 4. For each device group, build card and assign to primary's section
  for (const group of deviceMap.values()) {
    const primaryEid = group.primary.entity?.entity_id;
    const primaryDomain = getDomain(primaryEid);
    const targetSection =
      entityOriginalSection.get(primaryEid) || sectionForDomain(primaryDomain);

    // Get effective merge mode for the target section
    const sectionCfg = sectionConfigs?.[targetSection];
    const mode = getMergeMode(sectionCfg);

    let card;
    if (mode === 'none') {
      // Section has merge disabled — produce individual cards
      for (const c of group.entities) {
        const eid = c.entity?.entity_id;
        const sec =
          entityOriginalSection.get(eid) ||
          sectionForDomain(getDomain(eid));
        if (result.has(sec)) {
          result.get(sec).push(createButtonCard(c));
        }
        consumedIds.add(eid);
      }
      continue;
    }

    card = buildCard(group, mode, createButtonCard, createSubButton);

    if (result.has(targetSection)) {
      result.get(targetSection).push(card);
    } else if (result.has('bonbon_miscellaneous')) {
      result.get('bonbon_miscellaneous').push(card);
    }

    // Mark all entities in this group as consumed
    for (const c of group.entities) {
      consumedIds.add(c.entity?.entity_id);
    }
  }

  // 5. No-device entities → their original section, as individual cards
  for (const c of noDevice) {
    const eid = c.entity?.entity_id;
    const sec =
      entityOriginalSection.get(eid) || sectionForDomain(getDomain(eid));
    if (result.has(sec)) {
      result.get(sec).push(createButtonCard(c));
    }
    consumedIds.add(eid);
  }

  // 6. Mark consumed entity_ids in categorizedEntityIds
  for (const eid of consumedIds) {
    if (!area.categorizedEntityIds.includes(eid)) {
      area.categorizedEntityIds.push(eid);
    }
  }

  return result;
}

// ============================================================
// Fallback: single-section merge (for same-domain multi-entity devices)
// ============================================================

export function buildSectionCards(
  entities,
  mergeMode,
  createButtonCard,
  createSubButton,
) {
  if (mergeMode === 'none' || !mergeMode) {
    return entities.map((c) => createButtonCard(c));
  }

  const { deviceMap, noDevice } = groupByDevice(entities);
  const cards = [];

  const sortedGroups = [...deviceMap.values()].sort((a, b) => {
    const nameA = (
      a.device?.name_by_user ||
      a.device?.name ||
      ''
    ).toLowerCase();
    const nameB = (
      b.device?.name_by_user ||
      b.device?.name ||
      ''
    ).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  for (const group of sortedGroups) {
    cards.push(buildCard(group, mergeMode, createButtonCard, createSubButton));
  }

  for (const c of noDevice) {
    cards.push(createButtonCard(c));
  }

  return cards;
}
