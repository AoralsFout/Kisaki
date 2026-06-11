import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "@fortawesome/fontawesome-free/css/all.min.css";
import { createLogger } from "./utils/logger";

const log = createLogger('Main')

const app = createApp(App);
app.use(createPinia());
app.mount("#app");

log.info('应用已启动')
