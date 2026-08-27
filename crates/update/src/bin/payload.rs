//! 发布期的载荷生成器：格式只有一个产出方，与客户端的 apply 同源。
#![allow(
    clippy::print_stdout,
    reason = "标准输出上那一行哈希就是这个程序的返回值，发布脚本读它"
)]
use std::fs;
use poietica_update_native::{PayloadKind, decode, encode, hash};
/// full  <exe> <out>                      写整包载荷，打印成品哈希
/// patch <basePayload> <exe> <out>    写增量载荷，打印基线哈希
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments
        .split_first()
        .map(|(verb, rest)| (verb.as_str(), rest))
    {
        Some(("full", [exe, out])) => {
            let binary = fs::read(exe)?;
            fs::write(out, encode(PayloadKind::Full, &[], &binary)?)?;
            println!("{}", hash(&binary));
        }
        Some(("patch", [base_payload, exe, out])) => {
            let baseline = decode(PayloadKind::Full, &[], &fs::read(base_payload)?)?;
            let binary = fs::read(exe)?;
            fs::write(out, encode(PayloadKind::Patch, &baseline, &binary)?)?;
            println!("{}", hash(&baseline));
        }
        _unknown => {
            return Err("usage: poietica-update-payload full <exe> <out> | patch <basePayload> <exe> <out>".into());
        }
    }
    Ok(())
}
