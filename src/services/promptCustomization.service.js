const { getPromptCustomizations, addPromptCustomization } = require('../services/redis.service');

const CUSTOM_SECTION_TITLES = {
  diamond: 'CUSTOM DIAMOND OPTIONS (DYNAMIC)',
  colorstone: 'CUSTOM COLORSTONE OPTIONS (DYNAMIC)',
};

function formatList(values) {
  if (!values || values.length === 0) return 'None';
  return values.join(', ');
}

function buildCustomPromptSection(customizations, category = 'diamond') {
  if (!customizations) return '';
  const colors = formatList(customizations.colors);
  const clarities = formatList(customizations.clarities);
  const shapes = formatList(customizations.shapes);
  const packetCodes = formatList(customizations.packetCodes);
  const title = CUSTOM_SECTION_TITLES[category] ?? CUSTOM_SECTION_TITLES.diamond;

  if (category === 'colorstone') {
    return `\n==============================================================\n${title}\n==============================================================\nThese are additional custom colorstone options entered by users. Treat them as valid values when extracting colorstone color and clarity.\n- Custom Colors: ${colors}\n- Custom Clarities: ${clarities}\n`;
  }

  return `\n==============================================================\n${title}\n==============================================================\nThese are additional custom diamond options entered by users. Treat them as valid values when extracting diamond color, clarity, shape, and packet codes.\n- Custom Colors: ${colors}\n- Custom Clarities: ${clarities}\n- Custom Shapes: ${shapes}\n- Custom Packet Codes: ${packetCodes}\n`;
}

function buildCustomPromptSnippet(customizations, wordLimit = 100, category = 'diamond') {
  const section = buildCustomPromptSection(customizations, category);
  if (!section) return '';
  const words = section.replace(/\s+/g, ' ').trim().split(' ');
  return words.slice(0, wordLimit).join(' ');
}

module.exports = {
  CUSTOM_SECTION_TITLES,
  buildCustomPromptSection,
  buildCustomPromptSnippet,
  getPromptCustomizations,
  addPromptCustomization,
};
