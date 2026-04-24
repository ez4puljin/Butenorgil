import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bto.erp',
  appName: 'Bto',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
  },
  server: {
    // https scheme шаардлагатай — browser mediaDevices (камер) нь secure context-д л ажилладаг.
    // HTTP backend руу хандахыг CapacitorHttp plugin дамжуулж шийднэ.
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    // Бүх fetch/XMLHttpRequest-ийг native HTTP bridge-ээр явуулна.
    // WebView-ийн CORS, mixed-content хязгаарлалтыг бүрэн алгасдаг.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
