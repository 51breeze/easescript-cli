#!/usr/bin/env node  
const program = require('commander');

program.option('-V, --version', '当前版本号');
program.on('option:version', function() {
    const version = 'EaseScript '+require('../package.json').version;
    process.stdout.write(version + '\n');
    process.exit(0);
});

program.description('The command currently running is the easescript compiler.\n  which can build different target run code based on different syntax plugins')

program.usage('--file <file, ...> [options]')

program
.option('-f, --file <file>', '指定需要编译的文件',(val)=>{
    return val ? val.split(',') : [];
})
.option('-c, --config-file-name [file]', '指定配置文件','es.config')
.option('-o, --output [dir]', '输出路径', null)
.option('-p, --plugins [javascript,php]', '构建插件',function (val) {
    return val ? val.split(',') : [];
})
.option('-s, --suffix [.es]', '源文件的后缀名','.es')
.option('-l, --lang [zh-CN]', '语言','zh-CN')
.option('-w, --workspace [dir]', '源文件目录', process.cwd() )
.option('-r, --reserved [keyword1,keyword2,...]', '指定需要保护的关键字', function (val) {
    return val ? val.split(',') : [];
})
.option('-t, --types [file.d.es, ...]', '指定描述文件', function (val) {
    return val ? val.split(',') : [];
})
.option('-m, --mode [dev|test|production]', '构建模式是用于生产环境还是测试环境','production')
.option('-format, --format [esm]', '文件输出格式(iife,cjs,esm)','esm')
.option('-platform, --platform [node]', '运行平台(node,browser,neutral)','node')
.option('--debug', '是否打印调试信息',false)
.option('--throw-error', '当有错误时直接抛出',false)
.option('--minify', '启用压缩',false)
.option('--watch', '监视文件，当有文件变动时重新构建', false)
.option('--unbundle', '取消捆绑', false)
.option('--manifest', '构建类型清单', false)
.option('--typings, --typings [file.d.es,...]', '构建清单时需要提前加载的描述文件', function (val) {
    return val ? val.split(',') : []; 
})
.option('--clear', '清空构建目录', false)
.option('--emit-types', '生成文件类型', false)
.option('--scope [name]', '构建类型清单时指定的作用域', null)
.option('--inherit [plugin-name,...]', `构建类型清单时继承的作用域多个用','隔开`,function (val) {
    return val ? val.split(',') : [];
})
.option('--sourcemap', '生成源码映射', false)
.option('--esf', '生成源码映射文件', false)
.option('--exclude-global-class-bundle', '当导入全局类时设置为外部引用，来共享全局类的代码', false)

program.parse(process.argv);

if( process.argv.length < 2 ){
    program.outputHelp();
    process.exit(1);
}

const config = [
   "file",
   "configFileName",
   "throwError",
   "output",
   "plugins",
   "suffix",
   "types",
   "debug",
   "reserved",
   "mode",
   "format",
   "watch",
   "sourcemap",
   "emitSourcemapFile",
   "platform",
   "workspace",
   "minify",
   "unbundle",
   "manifest",
   "emitTypes",
   "typings",
   "scope",
   "inherit",
   "clear",
];
const options = {
    debug:false,
    throwError:false,
    minify:false,
    bundle:true,
    excludeGlobalClassBundle:false,
    mode:'production'
};
const alias = {
    esf:'emitSourcemapFile'
}
config.forEach( name=>{
    if( program[name] !== void 0 ){
        const key = alias[name] || name;
        options[key] = program[name];
    }
    if(name==='unbundle' && program[name]){
        options['bundle'] = false;
    }
    
});
options.commandLineEntrance = true;
if(options.manifest){
    const manifest = require('../lib/manifest.js');
    manifest(options);
}else{
    const compile = require('../lib/build.js');
    compile(options);
}