import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "@fortawesome/fontawesome-free/css/all.min.css";

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
