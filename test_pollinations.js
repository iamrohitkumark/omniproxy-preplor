// Test Pollinations API variations
async function test() {
  const models = ["openai-fast", "openai", "mistral", "deepseek"];
  
  console.log("=== Testing POST /openai ===");
  for (const m of models) {
    try {
      const res = await fetch("https://text.pollinations.ai/openai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: m,
          messages: [{ role: "user", content: "Say hello and 1 short line about physics." }],
          max_tokens: 1000
        })
      });
      console.log(`[POST /openai] model=${m}: status=${res.status}`);
      if (res.ok) {
        const data = await res.json();
        console.log("Response:", data?.choices?.[0]?.message?.content?.slice(0, 150));
      } else {
        const txt = await res.text();
        console.log("Err:", txt.slice(0, 150));
      }
    } catch (e) {
      console.log(`[POST /openai] model=${m} Exception:`, e.message);
    }
  }

  console.log("\n=== Testing GET prompt ===");
  try {
    const prompt = encodeURIComponent("Write a short question about physics");
    const res = await fetch(`https://text.pollinations.ai/${prompt}?model=openai-fast`);
    console.log(`[GET] model=openai-fast: status=${res.status}`);
    if (res.ok) {
      const txt = await res.text();
      console.log("GET Response:", txt.slice(0, 150));
    }
  } catch (e) {
    console.log("[GET] Exception:", e.message);
  }
}

test();
