const { ethers } = require("hardhat");
async function main(){
  const contract = "0x43Bd54422cCF6237935aB32fAd6081EC05Daf6Ca";
  const newOwner = "0x708fE30213362d712398307c072b92201832f279";
  const vest = await ethers.getContractAt("VestiLock", contract);
  const tx = await vest.transferOwnership(newOwner);
  await tx.wait();
  console.log("transferOwnership sent to:", newOwner);
}
main().catch(e=>{console.error(e);process.exit(1);});
