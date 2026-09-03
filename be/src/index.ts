import { createApp } from './app.js';
import { configFromEnv } from './config.js';

const port = Number(process.env.PORT ?? 3000);
const config = configFromEnv();
const app = createApp({ config });

app.listen(port, () => {
  console.log(
    `checkout service listening on :${port} (n=${config.milestoneInterval}, x=${config.discountPercent}%)`,
  );
});
