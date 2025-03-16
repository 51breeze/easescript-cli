const Compiler = require('easescript/lib/core/Compiler');
const Utils = require('easescript/lib/core/Utils');
const JSModule = require('easescript/lib/core/JSModule');
const Namespace = require('easescript/lib/core/Namespace');
const Cache = require('easescript/lib/core/Cache');
const path = require('path');
const fs = require('fs-extra');
async function manifest(compiler, paths, scope={}, output=null, options={}){
    await compiler.initialize();
    const inherits = [];
    const resolveFilePath = (paths)=>{
        const items = [];
        paths.forEach(file=>{
            const files = Utils.readdir(file, true);
            if(files){
                items.push(...files);
            }else if(fs.existsSync(file)){
                file = path.isAbsolute(file) ? file : path.resolve(file)
                items.push(file)
            }else{
                throw new ReferenceError(`File '${file}' is not exists.`)
            }
        });
        return items;
    }

    const resolvePkgFile = (name)=>{
        try{
            return require.resolve(path.join(name,'package.json'), options.resolvePaths ? {paths:options.resolvePaths} : void 0);
        }catch(e){
            return null;
        }
    }

    const inheritScopes = [];
    const _dataset = new Map();
    const parseInherit=(name)=>{
        const file = resolvePkgFile(name);
        if(file){
            compiler.resolveTypingsFromPackage(file, _dataset)
        }
    }

    let additions = []
    if( Array.isArray(options.additions) && options.additions.length>0 ){
        additions.push( ...resolveFilePath(options.additions) )
    }

    if( Array.isArray(scope.inherits) ){
        scope.inherits.forEach(parseInherit);
    }

    _dataset.forEach( value=>{
        inheritScopes.push( value.esconfig.scope )
        inherits.push( ...value.files )
    });
    scope.inherits = inheritScopes;

    if(additions.length>0){
        await compiler.loadTypes(additions, {scope:'unknown'})
    }
    
    if(inherits && inherits.length>0){
        await compiler.loadTypes(inherits, {scope:'unknown'})
    }

    paths = resolveFilePath(paths);
    await compiler.loadTypes(paths, {scope:'unknown'});
    const locals = new Set();

    paths.concat(additions).forEach( file=>{
        const res = compiler.getCompilation(file)
        if(res){
            locals.add(res);
        }
    });
    
    compiler.compilations.forEach( compilation=>{
        let flag = false;
        let com = compilation;
        while(com && !(flag=locals.has(com))){
            com = com.parent
        }
        if(flag){
            locals.add(compilation);
        }
    });

    if(output){
        output = path.isAbsolute(output) ? output : path.join(compiler.options.cwd, output)
        if(!/\.json/.test(output)){
            output = path.join(output, compiler.options.manifestFileName)
        }
    }else{
        output = path.join(compiler.options.cwd, compiler.options.manifestFileName)
    }

    const dataset = {};
    const files = new Set();
    const fileIndexerMaps = new Map();
    const rootPath = path.dirname(output);
    const excludes = options.excludes || ['/node_modules/'];
    const exclude = (file)=>{
        return Array.isArray(excludes) && excludes.some( name=>file.includes(name) );
    }

    const addIndexer=(compilation, ns, item, name, dataset)=>{
        let compilations = [item.compilation];
        if(item.isModule || JSModule.is(item)){
            compilations = item.getStacks().map( stack=>stack.compilation);
        }
        compilations = compilations.filter(Boolean);

        if(compilations.length===0)return;
        if(!compilations.some(compi=>exclude(compi.file) ? false : !compi.isGlobalFlag) ){
            return;
        }

        let isLocal = compilations.includes(compilation);
        if(isLocal && !inheritScopes.includes(compilation.pluginScopes.scope) ){
            const compiFiles =compilations.filter(compi=>!compi.isGlobalFlag).map(compi=>compi.file);
            const key = Namespace.is(ns) ? `${ns.getChain().concat(name).join('.')}` : name;
            const data = dataset[key] || (dataset[key] = {indexers:[]});
            compiFiles.forEach( file=>{
                let has = fileIndexerMaps.has(file);
                let index = 0;
                if(!has){
                    if(!files.has(file)){
                        files.add(file);
                    }
                    index = files.size-1;
                    fileIndexerMaps.set(file, index)
                }else{
                    index = fileIndexerMaps.get(file);
                }
                if( !data.indexers.includes(index) ){
                    data.indexers.push(index);
                }
            })
        }
    }
    
    locals.forEach( compilation=>{
        if(compilation.isGlobalFlag)return;
        const cache = new WeakSet();
        const make = (ns)=>{
            if(cache.has(ns))return;
            cache.add(ns);
            ns.modules.forEach( (item,name)=>{
                addIndexer(compilation, ns, item, name, dataset);
            });
            ns.descriptors.forEach( (items, name)=>{
                const item = items[0];
                if(item){
                    const key = Namespace.is(ns) ? `${ns.getChain().concat(name).join('.')}` : name;
                    if(!dataset[key]){
                        addIndexer(compilation, ns, item, name, dataset);
                    }
                }
            });
            ns.children.forEach(make);
        }
        compilation.namespaceSets.forEach( ns=>{
            make(ns);
        })
    });

    const jsModules = Cache.group('JSModule.records');
    const datasetModules = {};
    jsModules.values().forEach( jsModule=>{
        addIndexer(jsModule.compilation, null, jsModule, jsModule.id, datasetModules);
    });

    const relativeModulePath = compiler.normalizePath(path.join(compiler.options.cwd, 'node_modules'))
    const jsondata = {
        scope,
        files:Array.from(files.values()).map( file=>{
            if(file.includes(relativeModulePath)){
                return compiler.normalizePath(path.join(path.relative(output, compiler.options.cwd), path.relative(relativeModulePath,file)))
            }
            return compiler.normalizePath(path.relative(rootPath,file))
        }),
        types:dataset,
        modules:datasetModules
    }
   
    const dir = path.dirname(output);
    if(!fs.existsSync(dir)){
        fs.emptyDirSync(dir);
    }

    fs.writeFileSync(output, JSON.stringify(jsondata));
    console.info(`build successful output: '${output}'`)
}

module.exports = async(options={})=>{

    let files = options.file;
    const compilerOptions = {
        lang:'zh-CN',
        scanTypings:false,
        configFileName:null,
        suffix:null,
        workspace:null,
        reserved:null,
        throwError:null,
        types:null,
    }

    Object.keys(compilerOptions).forEach(key=>{
        if( options[key] ){
            compilerOptions[key] = options[key];
        }else if(compilerOptions[key]===null){
            delete compilerOptions[key];
        }
    });

    const compile = new Compiler(compilerOptions);
    let scope = options.scope;
    let inherit = options.inherit;
    let output = options.output || 'types';
    let additions = [];
    if( !path.isAbsolute(output) ){
        output = path.join(process.cwd(), output);
    }
    
    const pkg = path.join(process.cwd(), 'package.json');
    if(fs.existsSync(pkg)){
        const json = require(pkg);
        const esconfig = json.esconfig ?? {};
        if(!scope){
            scope = esconfig.scope || json.name
        }
        if(!inherit){
            inherit = esconfig.inherits
        }
    }

    if(Array.isArray(options.typings)){
        additions.push(...options.typings);
    }

    if(!scope){
        throw new TypeError('scope is not defined');
    }
    
    if( !Array.isArray(inherit) ){
        inherit = inherit ? [inherit] : []
    }

    if(!files && compile.options.input){
        files = compile.options.input;
    }

    if(files && !Array.isArray(files)){
        files = [files];
    }

    files = (files||[]).map( file=>{
        if(!path.isAbsolute(file)){
            file = path.join(compile.options.cwd, file)
        }
        if(!fs.existsSync(file))return [];
        if(fs.statSync(file).isDirectory()){
            const dir = file;
            const files = [];
            fs.readdirSync(dir).forEach( file=>{
                if(file==='.' || file==='..')return false;
                file = path.join(dir,file);
                if(fs.statSync(file).isFile() && file.endsWith(compile.options.suffix)){
                    files.push(file);
                }
            });
            return files;
        }else if(file.endsWith(compile.options.suffix)){
            return [file];
        }
        return []
    }).flat();
   
    if(!files.length){
        throw new ReferenceError('Not found entry files')
    }

    const resolvePaths = options.resolvePaths || compile.options.resolvePaths;
    await manifest(compile, files,{name:scope, inherits:inherit}, output, {
        excludes:options.excludes,
        additions:additions,
        resolvePaths:Array.isArray(resolvePaths) && resolvePaths.length>0 ? resolvePaths : null,
    })
};