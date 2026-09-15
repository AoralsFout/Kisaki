//! 针对状态归属的语法级边界检查，不依赖源码行数、旧变量名或源码快照。
//!
//! 沿生产入口的 mod 声明检查所有平台/feature 分支，排除明确的测试声明。
//! 支持显式 use/type 别名及常见表达式宏的输入；生产 glob、item 宏和 include! 明确报错。
//! 这是 syn 语法检查，不展开依赖中的过程宏，也不做 Rust 类型推断或跨函数数据流分析。

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

use proc_macro2::Span;
use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Attribute, Expr, FnArg, GenericArgument, Item, Meta, ReturnType, Type, UseTree};

pub type Sources = BTreeMap<PathBuf, String>;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Rule {
    GlobalState,
    StateMacro,
    TestBranch,
    AmbientDirectory,
    ManagedAssembly,
    UninspectedMacro,
    Source,
}

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Violation {
    pub file: PathBuf,
    pub line: usize,
    pub column: usize,
    pub rule: Rule,
    pub message: String,
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}:{} [{:?}] {}",
            self.file.display(),
            self.line,
            self.column,
            self.rule,
            self.message
        )
    }
}

fn violation(file: &Path, span: Span, rule: Rule, message: impl Into<String>) -> Violation {
    let position = span.start();
    Violation {
        file: file.to_path_buf(),
        line: position.line,
        column: position.column + 1,
        rule,
        message: message.into(),
    }
}

fn meta_children(meta: &Meta) -> Vec<Meta> {
    match meta {
        Meta::List(list) => Punctuated::<Meta, syn::Token![,]>::parse_terminated
            .parse2(list.tokens.clone())
            .map(|items| items.into_iter().collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn mentions_test(meta: &Meta) -> bool {
    meta.path().is_ident("test") || meta_children(meta).iter().any(mentions_test)
}

// 除 test 外的平台/feature 条件保持未知，不能把 any(test, windows) 误当成测试专用。
fn production_cfg(meta: &Meta) -> Option<bool> {
    if meta.path().is_ident("test") {
        return Some(false);
    }
    let children = meta_children(meta);
    let values: Vec<_> = children.iter().map(production_cfg).collect();
    if meta.path().is_ident("not") && values.len() == 1 {
        values[0].map(|value| !value)
    } else if meta.path().is_ident("all") {
        if values.contains(&Some(false)) {
            Some(false)
        } else if values.iter().all(|value| *value == Some(true)) {
            Some(true)
        } else {
            None
        }
    } else if meta.path().is_ident("any") {
        if values.contains(&Some(true)) {
            Some(true)
        } else if values.iter().all(|value| *value == Some(false)) {
            Some(false)
        } else {
            None
        }
    } else {
        None
    }
}

fn test_only(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attr| {
        attr.path().is_ident("test")
            || (attr.path().is_ident("cfg")
                && attr
                    .parse_args::<Meta>()
                    .is_ok_and(|meta| mentions_test(&meta) && production_cfg(&meta) == Some(false)))
    })
}

fn item_attrs(item: &Item) -> &[Attribute] {
    match item {
        Item::Const(item) => &item.attrs,
        Item::Enum(item) => &item.attrs,
        Item::ExternCrate(item) => &item.attrs,
        Item::Fn(item) => &item.attrs,
        Item::ForeignMod(item) => &item.attrs,
        Item::Impl(item) => &item.attrs,
        Item::Macro(item) => &item.attrs,
        Item::Mod(item) => &item.attrs,
        Item::Static(item) => &item.attrs,
        Item::Struct(item) => &item.attrs,
        Item::Trait(item) => &item.attrs,
        Item::TraitAlias(item) => &item.attrs,
        Item::Type(item) => &item.attrs,
        Item::Union(item) => &item.attrs,
        Item::Use(item) => &item.attrs,
        _ => &[],
    }
}

struct Unit {
    file: PathBuf,
    module: String,
    attrs: Vec<Attribute>,
    items: Vec<Item>,
}

struct Loader<'a> {
    sources: &'a Sources,
    units: Vec<Unit>,
    errors: Vec<Violation>,
    stack: Vec<PathBuf>,
}

impl Loader<'_> {
    fn file(&mut self, file: PathBuf, module: String) {
        if self.stack.contains(&file) {
            self.errors.push(violation(
                &file,
                Span::call_site(),
                Rule::Source,
                "模块路径形成递归",
            ));
            return;
        }
        let parsed = self
            .sources
            .get(&file)
            .ok_or_else(|| "找不到生产模块源码".to_owned())
            .and_then(|source| syn::parse_file(source).map_err(|error| error.to_string()));
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(error) => {
                self.errors
                    .push(violation(&file, Span::call_site(), Rule::Source, error));
                return;
            }
        };
        if test_only(&parsed.attrs) {
            return;
        }
        let parent = file.parent().unwrap_or(Path::new(""));
        let stem = file.file_stem().unwrap().to_string_lossy();
        let child_dir = if matches!(stem.as_ref(), "lib" | "main" | "mod" | "build") {
            parent.to_path_buf()
        } else {
            parent.join(stem.as_ref())
        };
        self.stack.push(file.clone());
        self.items(
            Unit {
                file: file.clone(),
                module,
                attrs: parsed.attrs,
                items: parsed.items,
            },
            child_dir,
            parent.to_path_buf(),
        );
        self.stack.pop();
    }

    fn items(&mut self, unit: Unit, child_dir: PathBuf, path_base: PathBuf) {
        for item in &unit.items {
            let Item::Mod(child) = item else { continue };
            if test_only(&child.attrs) {
                continue;
            }
            let name = child.ident.to_string();
            let module = format!("{}::{name}", unit.module);
            if let Some((_, items)) = &child.content {
                self.items(
                    Unit {
                        file: unit.file.clone(),
                        module,
                        attrs: Vec::new(),
                        items: items.clone(),
                    },
                    child_dir.join(&name),
                    child_dir.join(&name),
                );
                continue;
            }
            let explicit_path = child.attrs.iter().find_map(|attr| {
                if !attr.path().is_ident("path") {
                    return None;
                }
                if let Meta::NameValue(value) = &attr.meta {
                    if let Expr::Lit(literal) = &value.value {
                        if let syn::Lit::Str(path) = &literal.lit {
                            return Some(path.value());
                        }
                    }
                }
                None
            });
            let file = if let Some(path) = explicit_path {
                path_base.join(path)
            } else {
                let flat = child_dir.join(format!("{name}.rs"));
                let nested = child_dir.join(&name).join("mod.rs");
                match (
                    self.sources.contains_key(&flat),
                    self.sources.contains_key(&nested),
                ) {
                    (true, false) => flat,
                    (false, true) => nested,
                    _ => {
                        self.errors.push(violation(
                            &unit.file,
                            child.span(),
                            Rule::Source,
                            format!("模块 {module} 必须有唯一源码文件"),
                        ));
                        continue;
                    }
                }
            };
            self.file(file, module);
        }
        self.units.push(unit);
    }
}

#[derive(Clone)]
struct Alias {
    module: String,
    ty: Type,
}

#[derive(Clone, Default)]
struct Names {
    imports: BTreeMap<String, String>,
    aliases: BTreeMap<String, Alias>,
    aggregates: BTreeMap<String, (String, Vec<Type>)>,
    symbols: BTreeSet<String>,
    factories: BTreeSet<String>,
    instance_methods: BTreeSet<String>,
}

fn path_text(path: &syn::Path) -> String {
    path.segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

const MANAGED: &[&str] = &[
    "crate::app_paths::AppPaths",
    "crate::workspace_grants::WorkspaceGrants",
    "crate::command::ExecutionRegistry",
    "crate::tts::TtsConnectionPool",
];

impl Names {
    fn qualify(&self, raw: &str, module: &str) -> String {
        if let Some(rest) = raw.strip_prefix("self::") {
            return format!("{module}::{rest}");
        }
        if let Some(rest) = raw.strip_prefix("super::") {
            let parent = module
                .rsplit_once("::")
                .map_or("crate", |(parent, _)| parent);
            return self.qualify(&format!("self::{rest}"), parent);
        }
        let first = raw.split("::").next().unwrap_or(raw);
        let local = format!("{module}::{first}");
        if self.imports.contains_key(&local) || self.symbols.contains(&local) {
            format!("{module}::{raw}")
        } else {
            raw.to_owned()
        }
    }

    fn resolve(&self, raw: &str, module: &str) -> String {
        let mut name = self.qualify(raw, module);
        let mut seen = BTreeSet::new();
        while seen.insert(name.clone()) {
            let mut prefix = name.as_str();
            let replacement = loop {
                if let Some(target) = self.imports.get(prefix) {
                    break Some(format!("{target}{}", &name[prefix.len()..]));
                }
                let Some((parent, _)) = prefix.rsplit_once("::") else {
                    break None;
                };
                prefix = parent;
            };
            match replacement {
                Some(replacement) => name = replacement,
                None => break,
            }
        }
        name
    }

    fn collect_use(&mut self, tree: &UseTree, prefix: &str, module: &str) {
        match tree {
            UseTree::Path(path) => {
                self.collect_use(&path.tree, &format!("{prefix}{}::", path.ident), module)
            }
            UseTree::Group(group) => {
                for tree in &group.items {
                    self.collect_use(tree, prefix, module);
                }
            }
            UseTree::Name(name) => {
                let raw = if name.ident == "self" {
                    prefix.trim_end_matches("::").to_owned()
                } else {
                    format!("{prefix}{}", name.ident)
                };
                let local = raw.rsplit("::").next().unwrap();
                self.imports
                    .insert(format!("{module}::{local}"), self.qualify(&raw, module));
            }
            UseTree::Rename(rename) => {
                let raw = if rename.ident == "self" {
                    prefix.trim_end_matches("::").to_owned()
                } else {
                    format!("{prefix}{}", rename.ident)
                };
                self.imports.insert(
                    format!("{module}::{}", rename.rename),
                    self.qualify(&raw, module),
                );
            }
            UseTree::Glob(_) => {
                // 不尝试通用 glob 名称解析；生产导入由 visit_use_glob 明确拒绝。
            }
        }
    }

    fn collect(&mut self, items: &[Item], module: &str) {
        for item in items.iter().filter(|item| !test_only(item_attrs(item))) {
            let (name, fields) = match item {
                Item::Struct(item) => (
                    Some(&item.ident),
                    Some(item.fields.iter().map(|field| field.ty.clone()).collect()),
                ),
                Item::Enum(item) => (
                    Some(&item.ident),
                    Some(
                        item.variants
                            .iter()
                            .flat_map(|variant| &variant.fields)
                            .map(|field| field.ty.clone())
                            .collect(),
                    ),
                ),
                Item::Type(item) => {
                    self.aliases.insert(
                        format!("{module}::{}", item.ident),
                        Alias {
                            module: module.to_owned(),
                            ty: (*item.ty).clone(),
                        },
                    );
                    (Some(&item.ident), None)
                }
                Item::Fn(item) => (Some(&item.sig.ident), None),
                Item::Mod(item) => (Some(&item.ident), None),
                _ => (None, None),
            };
            if let Some(name) = name {
                let name = format!("{module}::{name}");
                self.symbols.insert(name.clone());
                if let Some(fields) = fields {
                    self.aggregates.insert(name, (module.to_owned(), fields));
                }
            }
        }
        for item in items.iter().filter(|item| !test_only(item_attrs(item))) {
            if let Item::Use(item) = item {
                self.collect_use(&item.tree, "", module);
            }
        }
    }

    fn owner(&self, raw: &str, module: &str) -> Option<String> {
        let mut name = self.resolve(raw, module);
        let mut seen = BTreeSet::new();
        while seen.insert(name.clone()) {
            if MANAGED.contains(&name.as_str()) {
                return Some(name);
            }
            let alias = self.aliases.get(&name)?;
            let Type::Path(ty) = &alias.ty else {
                return None;
            };
            name = self.resolve(&path_text(&ty.path), &alias.module);
        }
        None
    }

    fn has_type(&self, ty: &Type, module: &str, predicate: fn(&str) -> bool) -> bool {
        self.has_type_inner(ty, module, predicate, &mut BTreeSet::new())
    }

    fn has_type_inner(
        &self,
        ty: &Type,
        module: &str,
        predicate: fn(&str) -> bool,
        seen: &mut BTreeSet<String>,
    ) -> bool {
        match ty {
            Type::Path(ty) => {
                let name = self.resolve(&path_text(&ty.path), module);
                if predicate(&name) {
                    return true;
                }
                if seen.insert(name.clone()) {
                    if let Some(alias) = self.aliases.get(&name) {
                        if self.has_type_inner(&alias.ty, &alias.module, predicate, seen) {
                            return true;
                        }
                    }
                }
                ty.path.segments.iter().any(|segment| {
                    if let syn::PathArguments::AngleBracketed(args) = &segment.arguments {
                        args.args.iter().any(|arg| matches!(arg, GenericArgument::Type(ty) if self.has_type_inner(ty, module, predicate, seen)))
                    } else { false }
                })
            }
            Type::Reference(ty) => self.has_type_inner(&ty.elem, module, predicate, seen),
            Type::Array(ty) => self.has_type_inner(&ty.elem, module, predicate, seen),
            Type::Slice(ty) => self.has_type_inner(&ty.elem, module, predicate, seen),
            Type::Tuple(ty) => ty
                .elems
                .iter()
                .any(|ty| self.has_type_inner(ty, module, predicate, seen)),
            Type::Paren(ty) => self.has_type_inner(&ty.elem, module, predicate, seen),
            Type::Group(ty) => self.has_type_inner(&ty.elem, module, predicate, seen),
            _ => false,
        }
    }

    fn readonly(&self, ty: &Type, module: &str, depth: usize) -> bool {
        if depth > 20 {
            return false;
        }
        match ty {
            Type::Reference(ty) => {
                ty.mutability.is_none() && self.readonly(&ty.elem, module, depth + 1)
            }
            Type::Array(ty) => self.readonly(&ty.elem, module, depth + 1),
            Type::Slice(ty) => self.readonly(&ty.elem, module, depth + 1),
            Type::Tuple(ty) => ty
                .elems
                .iter()
                .all(|ty| self.readonly(ty, module, depth + 1)),
            Type::Paren(ty) => self.readonly(&ty.elem, module, depth + 1),
            Type::Group(ty) => self.readonly(&ty.elem, module, depth + 1),
            Type::Path(ty) => {
                let name = self.resolve(&path_text(&ty.path), module);
                if MANAGED.contains(&name.as_str()) {
                    return false;
                }
                if let Some(alias) = self.aliases.get(&name) {
                    return self.readonly(&alias.ty, &alias.module, depth + 1);
                }
                if let Some((module, fields)) = self.aggregates.get(&name) {
                    return fields.iter().all(|ty| self.readonly(ty, module, depth + 1));
                }
                let primitive = name
                    .strip_prefix("std::primitive::")
                    .or_else(|| name.strip_prefix("core::primitive::"))
                    .unwrap_or(&name);
                matches!(
                    primitive,
                    "str"
                        | "bool"
                        | "char"
                        | "u8"
                        | "u16"
                        | "u32"
                        | "u64"
                        | "u128"
                        | "usize"
                        | "i8"
                        | "i16"
                        | "i32"
                        | "i64"
                        | "i128"
                        | "isize"
                        | "f32"
                        | "f64"
                ) || matches!(
                    name.as_str(),
                    "std::time::Duration" | "core::time::Duration"
                )
            }
            _ => false,
        }
    }

    fn unit_lock(&self, ty: &Type, module: &str, lazy_allowed: bool, depth: usize) -> bool {
        if depth > 20 {
            return false;
        }
        let Type::Path(ty) = ty else { return false };
        let name = self.resolve(&path_text(&ty.path), module);
        if let Some(alias) = self.aliases.get(&name) {
            return self.unit_lock(&alias.ty, &alias.module, lazy_allowed, depth + 1);
        }
        let Some(segment) = ty.path.segments.last() else {
            return false;
        };
        let syn::PathArguments::AngleBracketed(args) = &segment.arguments else {
            return false;
        };
        let Some(GenericArgument::Type(inner)) = args.args.first() else {
            return false;
        };
        if args.args.len() != 1 {
            return false;
        }
        if name == "std::sync::Mutex" {
            matches!(inner, Type::Tuple(tuple) if tuple.elems.is_empty())
        } else {
            lazy_allowed
                && matches!(name.as_str(), "std::sync::OnceLock" | "std::sync::LazyLock")
                && self.unit_lock(inner, module, false, depth + 1)
        }
    }
}

fn managed(name: &str) -> bool {
    MANAGED.contains(&name)
}
fn directory_type(name: &str) -> bool {
    matches!(name, "std::path::Path" | "std::path::PathBuf")
}
fn path_input(name: &str) -> bool {
    directory_type(name)
        || managed(name)
        || matches!(name, "str" | "String" | "std::string::String")
}

fn directory_resolver(method: &str) -> bool {
    matches!(
        method,
        "app_data_dir"
            | "app_cache_dir"
            | "app_log_dir"
            | "app_local_data_dir"
            | "app_config_dir"
            | "home_dir"
            | "data_dir"
            | "cache_dir"
            | "config_dir"
    )
}
fn return_type(signature: &syn::Signature) -> Option<&Type> {
    match &signature.output {
        ReturnType::Type(_, ty) => Some(ty),
        ReturnType::Default => None,
    }
}

fn index_functions(names: &mut Names, units: &[Unit]) {
    for unit in units {
        for item in unit
            .items
            .iter()
            .filter(|item| !test_only(item_attrs(item)))
        {
            match item {
                Item::Fn(item) => {
                    if return_type(&item.sig)
                        .is_some_and(|ty| names.has_type(ty, &unit.module, managed))
                    {
                        names
                            .factories
                            .insert(format!("{}::{}", unit.module, item.sig.ident));
                    }
                }
                Item::Impl(item) => {
                    let Type::Path(ty) = item.self_ty.as_ref() else {
                        continue;
                    };
                    let Some(owner) = names.owner(&path_text(&ty.path), &unit.module) else {
                        continue;
                    };
                    for member in &item.items {
                        let syn::ImplItem::Fn(method) = member else {
                            continue;
                        };
                        if test_only(&method.attrs) {
                            continue;
                        }
                        let name = format!("{owner}::{}", method.sig.ident);
                        if method.sig.receiver().is_some() {
                            names.instance_methods.insert(name);
                        } else {
                            names.factories.insert(name);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

#[derive(Clone)]
struct Function {
    name: String,
    owner: Option<String>,
    constructor: bool,
}

struct Checker<'a> {
    unit: &'a Unit,
    names: Names,
    errors: &'a mut Vec<Violation>,
    log_locks: &'a mut usize,
    function: Option<Function>,
    impl_owner: Option<String>,
    function_depth: usize,
    fallback_depth: usize,
}

impl Checker<'_> {
    fn report(&mut self, span: Span, rule: Rule, message: impl Into<String>) {
        self.errors
            .push(violation(&self.unit.file, span, rule, message));
    }

    fn root(&self) -> bool {
        self.unit.file == Path::new("src/composition_root.rs")
            && self.unit.module == "crate::composition_root"
    }

    fn construction_allowed(&self, owner: &str) -> bool {
        self.root()
            || self.function.as_ref().is_some_and(|function| {
                function.constructor && function.owner.as_deref() == Some(owner)
            })
    }

    fn expression_name(&self, path: &syn::Path) -> String {
        let text = path_text(path);
        if let Some(rest) = text.strip_prefix("Self::") {
            if let Some(owner) = &self.impl_owner {
                return format!("{owner}::{rest}");
            }
        }
        if text == "Self" {
            if let Some(owner) = &self.impl_owner {
                return owner.clone();
            }
        }
        self.names.resolve(&text, &self.unit.module)
    }

    fn check_factory(&mut self, path: &syn::Path, qself: Option<&syn::QSelf>) {
        let name = self.expression_name(path);
        let owner = self
            .names
            .owner(&name, &self.unit.module)
            .or_else(|| {
                qself.and_then(|qself| {
                    if let Type::Path(ty) = qself.ty.as_ref() {
                        self.names.owner(&path_text(&ty.path), &self.unit.module)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| {
                name.rsplit_once("::")
                    .and_then(|(prefix, _)| self.names.owner(prefix, &self.unit.module))
            });
        if !self.root() && name.rsplit("::").next() == Some("manage") {
            self.report(
                path.span(),
                Rule::ManagedAssembly,
                "UFCS 状态托管也只能发生在组合根",
            );
        }
        let canonical_method = owner
            .as_ref()
            .map(|owner| format!("{owner}::{}", path.segments.last().unwrap().ident));
        if canonical_method
            .as_ref()
            .is_some_and(|method| self.names.instance_methods.contains(method))
        {
            return;
        }
        if let Some(owner) = owner {
            if !self.construction_allowed(&owner) {
                self.report(
                    path.span(),
                    Rule::ManagedAssembly,
                    format!("只能在组合根构造托管状态：{name}"),
                );
            }
        } else if self.names.factories.contains(&name) && !self.root() {
            let bootstrap = name == "crate::composition_root::setup"
                && self.unit.file == Path::new("src/lib.rs")
                && self.unit.module == "crate"
                && self
                    .function
                    .as_ref()
                    .is_some_and(|function| function.name == "run");
            if !bootstrap {
                self.report(
                    path.span(),
                    Rule::ManagedAssembly,
                    format!("组合根外不能调用状态装配入口：{name}"),
                );
            }
        }
    }

    fn check_signature(&mut self, signature: &syn::Signature) {
        let Some(output) = return_type(signature) else {
            return;
        };
        if let Type::Reference(reference) = output {
            if reference
                .lifetime
                .as_ref()
                .is_some_and(|lifetime| lifetime.ident == "static")
                && self
                    .names
                    .has_type(&reference.elem, &self.unit.module, |name| {
                        managed(name) || directory_type(name)
                    })
            {
                self.report(
                    signature.span(),
                    Rule::AmbientDirectory,
                    "目录与业务状态不得通过静态生命周期访问器取得",
                );
            }
        }
        if !self
            .names
            .has_type(output, &self.unit.module, directory_type)
        {
            return;
        }
        let injected = signature.inputs.iter().any(|input| match input {
            FnArg::Receiver(_) => true,
            FnArg::Typed(input) => self
                .names
                .has_type(&input.ty, &self.unit.module, path_input),
        });
        if !injected && !self.root() {
            self.report(
                signature.span(),
                Rule::AmbientDirectory,
                "返回路径的函数必须声明路径或状态来源，不能换名保留环境式目录入口",
            );
        }
    }

    fn enter_function(
        &mut self,
        signature: &syn::Signature,
        owner: Option<String>,
    ) -> Option<Function> {
        self.check_signature(signature);
        let constructor = signature.receiver().is_none()
            && return_type(signature).is_some_and(|ty| {
                matches!(ty, Type::Path(ty) if ty.path.is_ident("Self"))
                    || self.names.has_type(ty, &self.unit.module, managed)
                    || self
                        .names
                        .has_type(ty, &self.unit.module, |name| name == "Self")
            });
        self.function_depth += 1;
        self.function.replace(Function {
            name: signature.ident.to_string(),
            owner,
            constructor,
        })
    }

    fn directory_environment(&self, variable: &str) -> bool {
        matches!(variable, "TEMP" | "TMP" | "TMPDIR")
            || (!self.root()
                && matches!(
                    variable,
                    "HOME" | "USERPROFILE" | "APPDATA" | "LOCALAPPDATA" | "CARGO_MANIFEST_DIR"
                ))
    }

    fn macro_expressions(&mut self, mac: &syn::Macro) {
        if let Ok(expressions) =
            Punctuated::<Expr, syn::Token![,]>::parse_terminated.parse2(mac.tokens.clone())
        {
            for expression in expressions {
                self.visit_expr(&expression);
            }
            return;
        }
        let repeated = |input: syn::parse::ParseStream<'_>| -> syn::Result<(Expr, Expr)> {
            let value = input.parse()?;
            input.parse::<syn::Token![;]>()?;
            let count = input.parse()?;
            Ok((value, count))
        };
        if let Ok((value, count)) = repeated.parse2(mac.tokens.clone()) {
            self.visit_expr(&value);
            self.visit_expr(&count);
            return;
        }
        self.report(
            mac.span(),
            Rule::UninspectedMacro,
            "此宏的输入不是已支持的表达式语法；先扩展结构化解析，不得静默跳过",
        );
    }
}

// json! 的键值语法不是 Rust 表达式列表，但值可以包含任意 Rust 表达式，必须继续检查。
fn json_values(input: syn::parse::ParseStream<'_>) -> syn::Result<Vec<Expr>> {
    let mut expressions = Vec::new();
    if input.peek(syn::token::Brace) {
        let content;
        syn::braced!(content in input);
        while !content.is_empty() {
            expressions.push(content.parse()?);
            content.parse::<syn::Token![:]>()?;
            expressions.extend(json_values(&content)?);
            if content.is_empty() {
                break;
            }
            content.parse::<syn::Token![,]>()?;
        }
    } else if input.peek(syn::token::Bracket) {
        let content;
        syn::bracketed!(content in input);
        while !content.is_empty() {
            expressions.extend(json_values(&content)?);
            if content.is_empty() {
                break;
            }
            content.parse::<syn::Token![,]>()?;
        }
    } else {
        expressions.push(input.parse()?);
    }
    Ok(expressions)
}

impl<'ast> Visit<'ast> for Checker<'_> {
    fn visit_item(&mut self, item: &'ast Item) {
        // 只在声明边界排除测试。生产函数内部的 cfg(test) 语句和嵌套 item 仍会访问。
        if self.function_depth == 0 && test_only(item_attrs(item)) {
            return;
        }
        visit::visit_item(self, item);
    }

    fn visit_use_glob(&mut self, glob: &'ast syn::UseGlob) {
        self.report(
            glob.span(),
            Rule::Source,
            "生产 glob 导入可能隐藏敏感 API 别名；请显式列出导入项",
        );
    }
    fn visit_attribute(&mut self, attr: &'ast Attribute) {
        if (attr.path().is_ident("cfg") || attr.path().is_ident("cfg_attr"))
            && mentions_test(&attr.meta)
        {
            self.report(
                attr.span(),
                Rule::TestBranch,
                "生产代码不得按 cfg(test) 改变行为；测试专用代码请放在独立测试声明边界",
            );
        }
        visit::visit_attribute(self, attr);
    }

    fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
        for attr in &item.attrs {
            self.visit_attribute(attr);
        }
        if self.function_depth == 0 {
            return;
        } // 模块级子模块由 Loader 单独检查。
        if let Some((_, items)) = &item.content {
            let saved = self.names.clone();
            self.names.collect(items, &self.unit.module);
            for item in items {
                self.visit_item(item);
            }
            self.names = saved;
        } else {
            self.report(
                item.span(),
                Rule::Source,
                "函数内外部模块必须先扩展模块解析，不能漏检",
            );
        }
    }

    fn visit_block(&mut self, block: &'ast syn::Block) {
        let saved = self.names.clone();
        let items = block
            .stmts
            .iter()
            .filter_map(|statement| match statement {
                syn::Stmt::Item(item) => Some(item.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        self.names.collect(&items, &self.unit.module);
        visit::visit_block(self, block);
        self.names = saved;
    }

    fn visit_item_fn(&mut self, item: &'ast syn::ItemFn) {
        let previous = self.enter_function(&item.sig, None);
        visit::visit_item_fn(self, item);
        self.function = previous;
        self.function_depth -= 1;
    }

    fn visit_item_impl(&mut self, item: &'ast syn::ItemImpl) {
        let previous = self.impl_owner.take();
        if let Type::Path(ty) = item.self_ty.as_ref() {
            self.impl_owner = self.names.owner(&path_text(&ty.path), &self.unit.module);
        }
        visit::visit_item_impl(self, item);
        self.impl_owner = previous;
    }

    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        if self.function_depth == 0 && test_only(&item.attrs) {
            return;
        }
        let previous = self.enter_function(&item.sig, self.impl_owner.clone());
        visit::visit_impl_item_fn(self, item);
        self.function = previous;
        self.function_depth -= 1;
    }

    fn visit_item_static(&mut self, item: &'ast syn::ItemStatic) {
        let immutable = matches!(item.mutability, syn::StaticMutability::None);
        let log_scope = self.unit.file == Path::new("src/log.rs")
            && self.unit.module == "crate::log"
            && self
                .function
                .as_ref()
                .is_some_and(|function| function.name == "log_write_lock");
        if immutable && log_scope && self.names.unit_lock(&item.ty, &self.unit.module, true, 0) {
            *self.log_locks += 1;
            if *self.log_locks > 1 {
                self.report(
                    item.span(),
                    Rule::GlobalState,
                    "日志只能保留一个进程级写入互斥",
                );
            }
        } else if !immutable || !self.names.readonly(&item.ty, &self.unit.module, 0) {
            self.report(
                item.span(),
                Rule::GlobalState,
                "禁止环境式全局目录或可变业务状态；唯一例外是日志写入函数中的 Mutex<()> 进程互斥",
            );
        }
        visit::visit_item_static(self, item);
    }

    fn visit_foreign_item_static(&mut self, item: &'ast syn::ForeignItemStatic) {
        if !matches!(item.mutability, syn::StaticMutability::None)
            || !self.names.readonly(&item.ty, &self.unit.module, 0)
        {
            self.report(
                item.span(),
                Rule::GlobalState,
                "extern static 也不得暴露可变业务状态",
            );
        }
        visit::visit_foreign_item_static(self, item);
    }

    fn visit_item_const(&mut self, item: &'ast syn::ItemConst) {
        if !self.names.readonly(&item.ty, &self.unit.module, 0) {
            self.report(
                item.span(),
                Rule::GlobalState,
                "const 不能伪装目录或内部可变状态入口；普通只读常量不受限制",
            );
        }
        visit::visit_item_const(self, item);
    }

    fn visit_expr_path(&mut self, expression: &'ast syn::ExprPath) {
        self.check_factory(&expression.path, expression.qself.as_ref());
        let name = self.expression_name(&expression.path);
        if matches!(
            name.as_str(),
            "std::env::temp_dir"
                | "std::env::current_dir"
                | "std::env::home_dir"
                | "temp_dir"
                | "current_dir"
                | "home_dir"
        ) || name.starts_with("tempfile::")
            || (!self.root()
                && (name.starts_with("dirs::")
                    || name.starts_with("dirs_next::")
                    || name.starts_with("directories::")))
        {
            self.report(
                expression.span(),
                Rule::AmbientDirectory,
                format!("目录必须来自显式注入，不得从环境重新解析或兜底：{name}"),
            );
        }
        visit::visit_expr_path(self, expression);
    }

    fn visit_expr_struct(&mut self, expression: &'ast syn::ExprStruct) {
        if let Some(owner) = self
            .names
            .owner(&self.expression_name(&expression.path), &self.unit.module)
        {
            if !self.construction_allowed(&owner) {
                self.report(
                    expression.span(),
                    Rule::ManagedAssembly,
                    "组合根外不得通过结构体字面量重建托管状态",
                );
            }
        }
        visit::visit_expr_struct(self, expression);
    }

    fn visit_local(&mut self, local: &'ast syn::Local) {
        if let syn::Pat::Type(pattern) = &local.pat {
            if self.names.has_type(&pattern.ty, &self.unit.module, managed) && !self.root() {
                if let Some(initializer) = &local.init {
                    if let Expr::Call(call) = initializer.expr.as_ref() {
                        if matches!(call.func.as_ref(), Expr::Path(path) if path.path.segments.last().is_some_and(|segment| segment.ident == "default"))
                        {
                            self.report(
                                local.span(),
                                Rule::ManagedAssembly,
                                "不能用类型推断的 Default 重建托管状态",
                            );
                        }
                    }
                }
            }
        }
        visit::visit_local(self, local);
    }

    fn visit_expr_call(&mut self, expression: &'ast syn::ExprCall) {
        if let Expr::Path(function) = expression.func.as_ref() {
            let name = self.expression_name(&function.path);
            if let Some(Expr::Lit(literal)) = expression.args.first() {
                if let syn::Lit::Str(value) = &literal.lit {
                    let directory_constructor =
                        name.rsplit_once("::").is_some_and(|(ty, method)| {
                            matches!(method, "new" | "from")
                                && (directory_type(ty)
                                    || self.names.aliases.get(ty).is_some_and(|alias| {
                                        self.names.has_type(
                                            &alias.ty,
                                            &alias.module,
                                            directory_type,
                                        )
                                    }))
                        });
                    if directory_constructor
                        && (value.value().is_empty()
                            || value.value() == "."
                            || self.fallback_depth > 0)
                    {
                        self.report(
                            expression.span(),
                            Rule::AmbientDirectory,
                            "不得用当前目录或字面量目录掩盖装配失败",
                        );
                    }
                    if matches!(name.as_str(), "std::env::var" | "std::env::var_os")
                        && self.directory_environment(&value.value())
                    {
                        self.report(
                            expression.span(),
                            Rule::AmbientDirectory,
                            "不得通过目录环境变量恢复环境式目录入口",
                        );
                    }
                }
            }
            if self.fallback_depth > 0
                && name.rsplit_once("::").is_some_and(|(ty, method)| {
                    directory_type(ty)
                        && matches!(method, "new" | "default")
                        && expression.args.is_empty()
                })
            {
                self.report(
                    expression.span(),
                    Rule::AmbientDirectory,
                    "不得把空 PathBuf 当作目录兜底",
                );
            }
        }
        visit::visit_expr_call(self, expression);
    }

    fn visit_expr_method_call(&mut self, expression: &'ast syn::ExprMethodCall) {
        let method = expression.method.to_string();
        if method == "unwrap_or_default"
            && matches!(expression.receiver.as_ref(), Expr::MethodCall(call) if directory_resolver(&call.method.to_string()))
        {
            self.report(
                expression.span(),
                Rule::AmbientDirectory,
                "目录解析失败必须显式返回错误，不能用默认空目录继续装配",
            );
        }
        if !self.root() && (method == "manage" || directory_resolver(&method)) {
            let rule = if method == "manage" {
                Rule::ManagedAssembly
            } else {
                Rule::AmbientDirectory
            };
            self.report(
                expression.span(),
                rule,
                format!("{method} 只能在组合根解析或装配，命令与后台回调只能取得已托管状态"),
            );
        }
        let fallback = matches!(
            method.as_str(),
            "unwrap_or" | "unwrap_or_else" | "or" | "or_else" | "map_or" | "map_or_else"
        );
        for attr in &expression.attrs {
            self.visit_attribute(attr);
        }
        self.visit_expr(&expression.receiver);
        if let Some(arguments) = &expression.turbofish {
            self.visit_angle_bracketed_generic_arguments(arguments);
        }
        // 只有第一个参数是兜底；接收者和 map_or 的成功映射不属于降级路径。
        for (index, argument) in expression.args.iter().enumerate() {
            let fallback_argument = fallback && index == 0;
            if fallback_argument {
                self.fallback_depth += 1;
            }
            self.visit_expr(argument);
            if fallback_argument {
                self.fallback_depth -= 1;
            }
        }
    }

    fn visit_item_macro(&mut self, item: &'ast syn::ItemMacro) {
        for attr in &item.attrs {
            self.visit_attribute(attr);
        }
        let name = self.expression_name(&item.mac.path);
        if matches!(
            name.rsplit("::").next(),
            Some("thread_local" | "lazy_static")
        ) {
            self.visit_macro(&item.mac);
        } else {
            self.report(
                item.span(),
                Rule::UninspectedMacro,
                "生产 item 宏或 macro_rules 必须先提供结构化展开检查，不能藏入全局状态",
            );
        }
    }

    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        let name = self.expression_name(&mac.path);
        match name.rsplit("::").next().unwrap_or(&name) {
            "thread_local" | "lazy_static" => {
                self.report(
                    mac.span(),
                    Rule::StateMacro,
                    "生产代码不得用 thread_local!/lazy_static! 持有环境式状态",
                );
            }
            "cfg" => match syn::parse2::<Meta>(mac.tokens.clone()) {
                Ok(meta) if mentions_test(&meta) => self.report(
                    mac.span(),
                    Rule::TestBranch,
                    "生产表达式不得使用 cfg!(test) 分叉",
                ),
                Ok(_) => {}
                Err(error) => self.report(mac.span(), Rule::Source, error.to_string()),
            },
            "include" => self.report(
                mac.span(),
                Rule::UninspectedMacro,
                "include! 的生产源码必须先纳入模块解析，不能静默跳过",
            ),
            "include_str" | "include_bytes" => {}
            "env" | "option_env" => {
                if let Ok(variable) = syn::parse2::<syn::LitStr>(mac.tokens.clone()) {
                    if self.directory_environment(&variable.value()) {
                        self.report(
                            mac.span(),
                            Rule::AmbientDirectory,
                            "生产目录不得通过编译期环境变量重新取得",
                        );
                    }
                }
            }
            "matches" => {
                let parser = |input: syn::parse::ParseStream<'_>| -> syn::Result<(Expr, syn::Pat, Option<Expr>)> {
                    let expression = input.parse()?;
                    input.parse::<syn::Token![,]>()?;
                    let pattern = syn::Pat::parse_multi_with_leading_vert(input)?;
                    let guard = if input.peek(syn::Token![if]) { input.parse::<syn::Token![if]>()?; Some(input.parse()?) } else { None };
                    if input.peek(syn::Token![,]) { input.parse::<syn::Token![,]>()?; }
                    Ok((expression, pattern, guard))
                };
                match parser.parse2(mac.tokens.clone()) {
                    Ok((expression, pattern, guard)) => {
                        self.visit_expr(&expression);
                        self.visit_pat(&pattern);
                        if let Some(guard) = guard {
                            self.visit_expr(&guard);
                        }
                    }
                    Err(error) => {
                        self.report(mac.span(), Rule::UninspectedMacro, error.to_string())
                    }
                }
            }
            "json" => match json_values.parse2(mac.tokens.clone()) {
                Ok(expressions) => {
                    for expression in expressions {
                        self.visit_expr(&expression);
                    }
                }
                Err(error) => self.report(mac.span(), Rule::UninspectedMacro, error.to_string()),
            },
            _ => self.macro_expressions(mac),
        }
    }
}

pub fn check_sources(sources: &Sources, roots: &[&str]) -> Vec<Violation> {
    let mut errors = Vec::new();
    for root in roots {
        let mut loader = Loader {
            sources,
            units: Vec::new(),
            errors: Vec::new(),
            stack: Vec::new(),
        };
        loader.file(PathBuf::from(root), "crate".to_owned());
        errors.extend(loader.errors);
        let mut names = Names::default();
        for unit in &loader.units {
            names.collect(&unit.items, &unit.module);
        }
        index_functions(&mut names, &loader.units);
        let mut log_locks = 0;
        for unit in &loader.units {
            let mut checker = Checker {
                unit,
                names: names.clone(),
                errors: &mut errors,
                log_locks: &mut log_locks,
                function: None,
                impl_owner: None,
                function_depth: 0,
                fallback_depth: 0,
            };
            for attr in &unit.attrs {
                checker.visit_attribute(attr);
            }
            for item in &unit.items {
                checker.visit_item(item);
            }
        }
    }
    errors.sort();
    errors.dedup();
    errors
}
