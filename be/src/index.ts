import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { seedProducts } from './seed.js';
import { createMemoryRepositories } from './store/memory.js';

const port = Number(process.env.PORT ?? 3000);
const config = configFromEnv();

const repos = createMemoryRepositories();
seedProducts(repos.products);

const app = createApp({ config, repos });

app.listen(port, () => {
  console.log(
    `checkout service listening on :${port} (n=${config.milestoneInterval}, x=${config.discountPercent}%)`,
  );
});
