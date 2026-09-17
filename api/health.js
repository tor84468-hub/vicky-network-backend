export default function handler(req, res) {
  res.status(200).json({
    success: true,
    service: "Vicky Network backend",
    status: "running",
    platform: "vercel"
  });
}
