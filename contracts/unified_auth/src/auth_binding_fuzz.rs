//! Fuzz cases for authorization argument binding (#1063).
//!
//! A Soroban authorization binds the contract address, function symbol, the
//! exact argument list and a nonce. These tests start from one valid
//! authorization and apply seeded random mutations to each bound field. Only the
//! exact authorized invocation may succeed; every mutation must be rejected and
//! leave contract storage byte-for-byte unchanged.
//!
//! Deterministic: a fixed seed drives a small xorshift PRNG, so a failure is
//! reproducible from the printed iteration and mutation.
#![cfg(test)]
extern crate std;

use std::vec::Vec as StdVec;

use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal, Val, Vec,
};

use super::{ContractId, DataKey, UnifiedAuthContract, UnifiedAuthContractClient, UnifiedRole};

const SEED: u64 = 0x1063_a0b1_c2d3_e4f5;
const ITERATIONS: usize = 256;

/// Function symbols the contract exposes that take admin auth (plus noise).
const FN_NAMES: [&str; 7] = [
    "grant_role",
    "revoke_role",
    "transfer_super_admin",
    "register_contract",
    "unregister_contract",
    "init",
    "grant_rolf",
];

// ─── Deterministic PRNG ──────────────────────────────────────────────────────

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn role(i: usize) -> UnifiedRole {
    match i % 9 {
        0 => UnifiedRole::SuperAdmin,
        1 => UnifiedRole::EmergencyAdmin,
        2 => UnifiedRole::VaultAdmin,
        3 => UnifiedRole::UpgradeAdmin,
        4 => UnifiedRole::StrategyAdmin,
        5 => UnifiedRole::RoleAdmin,
        6 => UnifiedRole::OracleProvider,
        7 => UnifiedRole::AgentOperator,
        _ => UnifiedRole::StrategyOperator,
    }
}

fn contract_id(i: usize) -> ContractId {
    match i % 5 {
        0 => ContractId::CoreVault,
        1 => ContractId::Rbac,
        2 => ContractId::StrategyRegistry,
        3 => ContractId::StrategyBoundary,
        _ => ContractId::LiquidityVault,
    }
}

// ─── Fixture & storage snapshot ──────────────────────────────────────────────

struct Fixture {
    env: Env,
    id: Address,
    /// A second deployment of the same contract, also administered by `admin`.
    other: Address,
    admin: Address,
    users: [Address; 3],
}

fn setup() -> Fixture {
    let env = Env::default();
    let id = env.register_contract(None, UnifiedAuthContract);
    let other = env.register_contract(None, UnifiedAuthContract);
    let admin = Address::generate(&env);
    UnifiedAuthContractClient::new(&env, &id).init(&admin);
    UnifiedAuthContractClient::new(&env, &other).init(&admin);
    let users = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    Fixture { env, id, other, admin, users }
}

#[derive(Debug, PartialEq)]
struct Snapshot {
    admin: Address,
    roles: StdVec<bool>,
    registered: StdVec<(bool, Option<Address>)>,
}

fn snapshot(f: &Fixture, contract: &Address) -> Snapshot {
    let client = UnifiedAuthContractClient::new(&f.env, contract);
    let admin = f.env.as_contract(contract, || {
        f.env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::SuperAdmin)
            .unwrap()
    });
    let mut roles = StdVec::new();
    for user in f.users.iter() {
        for r in 0..9 {
            roles.push(client.has_role(user, &role(r)));
        }
    }
    let registered = (0..5)
        .map(|c| {
            (
                client.is_contract_registered(&contract_id(c)),
                client.get_contract_address(&contract_id(c)),
            )
        })
        .collect();
    Snapshot { admin, roles, registered }
}

// ─── Invocations under test ──────────────────────────────────────────────────

#[derive(Clone)]
enum Call {
    Grant(Address, UnifiedRole),
    Register(ContractId, Address),
}

impl Call {
    fn fn_name(&self) -> &'static str {
        match self {
            Call::Grant(..) => "grant_role",
            Call::Register(..) => "register_contract",
        }
    }

    fn args(&self, env: &Env) -> Vec<Val> {
        match self {
            Call::Grant(to, r) => (to.clone(), r.clone()).into_val(env),
            Call::Register(c, a) => (c.clone(), a.clone()).into_val(env),
        }
    }

    /// Arguments in reversed order (same values, wrong binding).
    fn reordered_args(&self, env: &Env) -> Vec<Val> {
        match self {
            Call::Grant(to, r) => (r.clone(), to.clone()).into_val(env),
            Call::Register(c, a) => (a.clone(), c.clone()).into_val(env),
        }
    }

    /// Invoke without setting any auth; returns true only on full success.
    fn invoke(&self, f: &Fixture) -> bool {
        let client = UnifiedAuthContractClient::new(&f.env, &f.id);
        match self {
            Call::Grant(to, r) => matches!(client.try_grant_role(to, r), Ok(Ok(()))),
            Call::Register(c, a) => {
                matches!(client.try_register_contract(c, a), Ok(Ok(())))
            }
        }
    }
}

fn authorize(f: &Fixture, contract: &Address, fn_name: &str, args: Vec<Val>) {
    f.env.mock_auths(&[MockAuth {
        address: &f.admin,
        invoke: &MockAuthInvoke {
            contract,
            fn_name,
            args,
            sub_invokes: &[],
        },
    }]);
}

fn random_call(rng: &mut Rng, f: &Fixture) -> Call {
    if rng.below(2) == 0 {
        Call::Grant(f.users[rng.below(3)].clone(), role(rng.below(9)))
    } else {
        Call::Register(contract_id(rng.below(5)), f.users[rng.below(3)].clone())
    }
}

/// A different call of the same function: one argument changed.
fn mutate_arg_value(rng: &mut Rng, f: &Fixture, call: &Call) -> Call {
    match call {
        Call::Grant(to, r) => {
            if rng.below(2) == 0 {
                let other = f.users.iter().find(|u| *u != to).unwrap().clone();
                Call::Grant(other, r.clone())
            } else {
                let mut next = role(rng.below(9));
                while next == *r {
                    next = role(rng.below(9));
                }
                Call::Grant(to.clone(), next)
            }
        }
        Call::Register(c, a) => {
            if rng.below(2) == 0 {
                let other = f.users.iter().find(|u| *u != a).unwrap().clone();
                Call::Register(c.clone(), other)
            } else {
                let mut next = contract_id(rng.below(5));
                while next == *c {
                    next = contract_id(rng.below(5));
                }
                Call::Register(next, a.clone())
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Mutation {
    ContractAddress,
    FunctionSymbol,
    ArgumentOrder,
    ArgumentValue,
    ArgumentCount,
    NonceReuse,
}

const MUTATIONS: [Mutation; 6] = [
    Mutation::ContractAddress,
    Mutation::FunctionSymbol,
    Mutation::ArgumentOrder,
    Mutation::ArgumentValue,
    Mutation::ArgumentCount,
    Mutation::NonceReuse,
];

// ─── Tests ───────────────────────────────────────────────────────────────────

#[test]
fn exact_authorized_invocation_succeeds() {
    let mut rng = Rng(SEED);
    for _ in 0..32 {
        let f = setup();
        let call = random_call(&mut rng, &f);
        authorize(&f, &f.id, call.fn_name(), call.args(&f.env));
        assert!(call.invoke(&f), "exact authorization must succeed");
        match &call {
            Call::Grant(to, r) => {
                assert!(UnifiedAuthContractClient::new(&f.env, &f.id).has_role(to, r))
            }
            Call::Register(c, a) => assert_eq!(
                UnifiedAuthContractClient::new(&f.env, &f.id).get_contract_address(c),
                Some(a.clone())
            ),
        }
    }
}

#[test]
fn fuzz_mutated_authorizations_are_rejected_without_state_change() {
    let mut rng = Rng(SEED);
    let mut seen = [0usize; 6];

    for i in 0..ITERATIONS {
        let f = setup();
        let call = random_call(&mut rng, &f);
        let mutation = MUTATIONS[rng.below(MUTATIONS.len())];
        seen[mutation as usize] += 1;

        // What actually gets invoked vs. what the admin authorized.
        let invoked = match mutation {
            Mutation::ArgumentValue => mutate_arg_value(&mut rng, &f, &call),
            _ => call.clone(),
        };

        if let Mutation::NonceReuse = mutation {
            // Consume the authorization once, undo its effect directly in
            // storage, then (below) replay the same call with the spent nonce.
            authorize(&f, &f.id, call.fn_name(), call.args(&f.env));
            assert!(call.invoke(&f), "iteration {i}: first use must succeed");
            f.env.as_contract(&f.id, || match &call {
                Call::Grant(to, r) => f
                    .env
                    .storage()
                    .persistent()
                    .remove(&DataKey::HasRole(to.clone(), r.clone())),
                Call::Register(c, _) => {
                    f.env.storage().instance().remove(&DataKey::RegisteredContract(c.clone()));
                    f.env.storage().instance().remove(&DataKey::ContractAddress(c.clone()));
                }
            });
        }

        // Snapshot before setting the mutated authorization so nothing runs
        // between `mock_auths` and the invocation under test.
        let before = snapshot(&f, &f.id);
        let other_before = snapshot(&f, &f.other);

        match mutation {
            Mutation::ContractAddress => {
                authorize(&f, &f.other, call.fn_name(), call.args(&f.env))
            }
            Mutation::FunctionSymbol => {
                let mut name = FN_NAMES[rng.below(FN_NAMES.len())];
                while name == call.fn_name() {
                    name = FN_NAMES[rng.below(FN_NAMES.len())];
                }
                authorize(&f, &f.id, name, call.args(&f.env))
            }
            Mutation::ArgumentOrder => {
                authorize(&f, &f.id, call.fn_name(), call.reordered_args(&f.env))
            }
            Mutation::ArgumentValue => authorize(&f, &f.id, call.fn_name(), call.args(&f.env)),
            Mutation::ArgumentCount => {
                let mut args = call.args(&f.env);
                if rng.below(2) == 0 {
                    args.pop_back();
                } else {
                    args.push_back(().into_val(&f.env));
                }
                authorize(&f, &f.id, call.fn_name(), args)
            }
            Mutation::NonceReuse => {} // prepared above; no fresh authorization
        }

        assert!(
            !invoked.invoke(&f),
            "iteration {i}: {mutation:?} authorization was accepted"
        );
        assert_eq!(
            snapshot(&f, &f.id),
            before,
            "iteration {i}: {mutation:?} changed storage"
        );
        assert_eq!(
            snapshot(&f, &f.other),
            other_before,
            "iteration {i}: {mutation:?} changed the other deployment"
        );
    }

    for (m, count) in MUTATIONS.iter().zip(seen.iter()) {
        assert!(*count > 0, "mutation {m:?} was never exercised");
    }
}

#[test]
fn authorization_for_one_deployment_is_not_usable_on_another() {
    // Boundary case: same code, same admin, same args, different contract id.
    let f = setup();
    let call = Call::Grant(f.users[0].clone(), UnifiedRole::VaultAdmin);
    authorize(&f, &f.id, call.fn_name(), call.args(&f.env));

    let other = UnifiedAuthContractClient::new(&f.env, &f.other);
    assert!(other.try_grant_role(&f.users[0], &UnifiedRole::VaultAdmin).is_err());
    assert!(!other.has_role(&f.users[0], &UnifiedRole::VaultAdmin));
}

#[test]
fn no_authorization_is_rejected() {
    let f = setup();
    let before = snapshot(&f, &f.id);
    let call = Call::Register(ContractId::CoreVault, f.users[0].clone());
    assert!(!call.invoke(&f));
    assert_eq!(snapshot(&f, &f.id), before);
}
