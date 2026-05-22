process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
const { scrapePage, looksLikeJobDetailUrl } = require('./server/controllers/aiHubController');

async function run() {
  const url = 'https://www.jobsateneco.com/vacancies';
  console.log(`Testing scrape for: ${url}`);
  const data = await scrapePage(url, 'https://www.jobsateneco.com', true);
  const jobLinks = data.links.filter(l => looksLikeJobDetailUrl(l.url, url));
  console.log(`Found ${jobLinks.length} job links:`, jobLinks);
}
run();
