const { ethers } = require("hardhat");

async function main() {
  const days = [30,60,90,120,180,210,240,270,300,330,360];
  const feeCollector = process.env.FEE_COLLECTOR;
  if (!feeCollector) throw new Error("FEE_COLLECTOR not set");

  const VestiLock = await ethers.getContractFactory("VestiLock");
  const vest = await VestiLock.deploy(days, feeCollector);
  await vest.deployed();

  console.log("VestiLock:", vest.address);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
