// scripts/deploy.js
const hre = require("hardhat");

async function main() {
  const days = [1,30,60,90,120,180,210,240,270,300,330,360];
  const feeCollector = process.env.FEE_COLLECTOR;
  if (!feeCollector) throw new Error("FEE_COLLECTOR not set");

  const VestiLock = await hre.ethers.getContractFactory("VestiLock");
  const vest = await VestiLock.deploy(days, feeCollector);

  // ✅ ethers v6: wait for deployment
  await vest.waitForDeployment();

  // getAddress() is v6-friendly
  console.log("VestiLock deployed at:", await vest.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
