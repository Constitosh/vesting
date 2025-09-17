const hre = require("hardhat");

async function main() {
  const contractAddr = "0x43Bd54422cCF6237935aB32fAd6081EC05Daf6Ca";   // replace with your VestiLock contract
  const vest = await hre.ethers.getContractAt("VestiLock", contractAddr);

  // Call acceptOwnership from whichever account is set as pendingOwner
  const tx = await vest.acceptOwnership();
  console.log("acceptOwnership tx sent:", tx.hash);
  await tx.wait();
  console.log("✅ Ownership accepted. New owner is now:", await vest.owner());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
