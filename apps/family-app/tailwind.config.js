import preset from '../../packages/shared/tailwind-preset.cjs';

export default {
  presets: [preset],
  content: ['./index.html', './src/**/*.{js,jsx}', '../../packages/shared/src/**/*.{js,jsx}'],
};
